(()=>{
  'use strict';
  if('scrollRestoration' in history)history.scrollRestoration='manual';
  const reader=window.NoteReader;
  const C=window.NOTEBOOK_CONFIG,$=id=>document.getElementById(id),store=new NotebookGitHub.Store(C);
  const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const disk={read(key,fallback){try{return JSON.parse(localStorage.getItem('notebook.'+key))??fallback;}catch{return fallback;}},write(key,value){try{localStorage.setItem('notebook.'+key,JSON.stringify(value));return true;}catch{return false;}}};
  const repoUrl='https://github.com/'+C.owner+'/'+C.repo,githubPath=path=>path.split('/').map(encodeURIComponent).join('/');
  const guide={id:'guide',type:'guide',title:'iTOP-RK3568 驱动开发指南',notebook:'参考资料',updated:null};
  let documents=disk.read('cache',[]),drafts=disk.read('drafts',{}),recent=disk.read('recent',[]),current=null,currentRoute='home',editorMode='read';
  let selectedIds=new Set(),visibleDocIds=[],pendingTrash=null,dialogDelete=null,deleting=false;
  let refreshPromise=null,routeSequence=0,toastTimer,previewTimer,draftTimer,pdfObjectUrl=null,saving=false;
  const systemTheme=matchMedia('(prefers-color-scheme: dark)');let theme='system';
  try{theme=JSON.parse(localStorage.getItem('rk3568.themeMode'))||'system';}catch{}
  const now=()=>new Date().toISOString();
  const uuid=()=>crypto.randomUUID();
  const noteHash=id=>'#note/'+encodeURIComponent(id),pdfHash=id=>'#pdf/'+encodeURIComponent(id);
  function notify(message){clearTimeout(toastTimer);$('toastMessage').textContent=message;$('undoTrashButton').hidden=true;$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,3600);}
  function date(value){if(!value||Number.isNaN(Date.parse(value)))return '—';return new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(value));}
  function allNotes(){const map=new Map(documents.map(d=>[d.id,d]));for(const draft of Object.values(drafts))map.set(draft.id,{...draft,localDraft:true});return [...map.values()];}
  function persistDrafts(){const saved=disk.write('drafts',drafts);$('draftCount').textContent=Object.keys(drafts).length||'';if(!saved){$('saveStatus').textContent='本机存储已满，请及时导出或保存';notify('本机存储空间不足，请导出 Markdown 或保存到 GitHub。');}return saved;}
  function persistCurrent(){if(!current||current.type!=='note')return;const next={...current,title:$('noteTitle').value,notebook:$('noteNotebook').value||'学习笔记',body:$('noteBody').value,updated:now()};current=next;drafts[next.id]=next;if(persistDrafts())$('saveStatus').textContent='草稿已保存在此设备';updateNotebooks();}
  function captureEditor(){clearTimeout(draftTimer);if(current&&current.type==='note'&&drafts[current.id])persistCurrent();}
  function addRecent(id){recent=[id,...recent.filter(x=>x!==id)].slice(0,40);disk.write('recent',recent);}
  function setTheme(mode,persist=true){theme=['system','light','dark'].includes(mode)?mode:'system';document.documentElement.classList.toggle('dark',theme==='dark'||(theme==='system'&&systemTheme.matches));$('themeSelect').value=theme;if(persist){try{localStorage.setItem('rk3568.themeMode',JSON.stringify(theme));}catch{}}syncGuideTheme();}
  function syncGuideTheme(){const frame=$('guideFrame');if(frame.dataset.loaded==='true')frame.contentWindow.postMessage({type:'notebook-theme',mode:theme},location.origin);}
  systemTheme.addEventListener('change',()=>{if(theme==='system')setTheme(theme,false);});
  function sidebar(open){if(matchMedia('(max-width:850px)').matches){$('sidebar').classList.toggle('open',open);$('backdrop').hidden=!open;document.body.classList.toggle('menu-open',open);$('sidebar').inert=!open;}else{document.body.classList.toggle('compact',!open);$('sidebar').inert=!open;}$('menuButton').setAttribute('aria-expanded',String(open));}
  function requireConnection(){if(store.token)return true;$('connectError').textContent='';$('connectDialog').showModal();return false;}
  function updateNotebooks(){const counts=new Map([['学习笔记',0],['参考资料',0]]);for(const doc of allNotes().filter(d=>!d.trashed))counts.set(doc.notebook,(counts.get(doc.notebook)||0)+1);$('notebookList').innerHTML=[...counts].map(([name,count])=>`<a href="#notebook/${encodeURIComponent(name)}" data-notebook="${esc(name)}">▱ ${esc(name)}<span>${count}</span></a>`).join('');$('notebookOptions').innerHTML=[...counts.keys()].map(name=>`<option value="${esc(name)}"></option>`).join('');markNavigation();}
  function markNavigation(){document.querySelectorAll('[data-view]').forEach(a=>{a.classList.toggle('active',a.dataset.view===currentRoute);});$('guideNav').classList.toggle('active',currentRoute==='guide');document.querySelectorAll('[data-notebook]').forEach(a=>a.classList.toggle('active',currentRoute==='notebook/'+a.dataset.notebook));}
  async function refreshLibrary(quiet=false){
    if(deleting)return;
    if(refreshPromise)return refreshPromise;
    captureEditor();const readingId=current?.id,readingPosition=reader.position(),readingMode=editorMode;
    $('cloudStatus').textContent='正在同步…';$('refreshButton').disabled=true;$('noteSync').disabled=true;
    refreshPromise=(async()=>{try{documents=await store.list();disk.write('cache',documents);$('cloudStatus').textContent='已同步';
      if(readingId&&current?.id===readingId&&current.type==='note'){
        const fresh=documents.find(d=>d.id===readingId);
        if(fresh&&(fresh.sha!==current.sha||(!drafts[readingId]&&(fresh.body!==current.body||fresh.title!==current.title||fresh.notebook!==current.notebook)))){
          if(drafts[readingId]){$('syncNotice').hidden=false;$('syncNotice').textContent='云端有新版本；当前显示本机草稿，尚未发布。请查看云端版本并比较后保存或另存副本。';$('conflictPanel').hidden=false;$('conflictLink').href=repoUrl+'/blob/'+encodeURIComponent(C.branch)+'/'+githubPath(fresh.path);$('saveStatus').textContent='本机草稿 · 云端有更新';}
          else{showNote(fresh);setEditorMode(readingMode);requestAnimationFrame(()=>reader.restore(readingPosition));$('syncNotice').hidden=false;$('syncNotice').textContent='当前正文已更新到云端最新版本，阅读位置已保留。';}
        }else if(!fresh&&current.sha){$('syncNotice').hidden=false;$('syncNotice').textContent='云端已找不到这篇笔记，当前内容仍保留在页面；请导出备份或另存副本。';}
      }
      if(!quiet)notify('已读取 GitHub 最新内容');}
      catch(error){$('cloudStatus').textContent='暂未同步';if(!documents.length){try{const response=await fetch('bootstrap.json');if(response.ok)documents=await response.json();}catch{}}if(!quiet)notify(error.message);$('listStatus').textContent=error.message+' 本机已有的笔记和草稿仍可查看。';}
      finally{refreshPromise=null;$('refreshButton').disabled=false;$('noteSync').disabled=false;updateNotebooks();if(!$('libraryView').hidden)renderList();}})();return refreshPromise;
  }
  function renderList(){
    const search=$('searchInput').value.trim().toLowerCase();let items=allNotes();
    const trashed=currentRoute==='trash';items=items.filter(d=>!!d.trashed===trashed);
    if(currentRoute==='favorites')items=items.filter(d=>d.favorite);
    if(currentRoute==='drafts')items=items.filter(d=>d.localDraft);
    if(currentRoute==='recent')items=items.filter(d=>recent.includes(d.id));
    if(currentRoute.startsWith('notebook/'))items=items.filter(d=>d.notebook===currentRoute.slice(9));
    if(search)items=items.filter(d=>reader.fold([d.title,d.body||'',d.notebook].join('\n')).includes(reader.fold(search)));
    if(currentRoute==='recent')items.sort((a,b)=>recent.indexOf(a.id)-recent.indexOf(b.id));
    else if($('sortSelect').value==='title')items.sort((a,b)=>a.title.localeCompare(b.title,'zh-CN'));
    else items.sort((a,b)=>(b.updated||'').localeCompare(a.updated||''));
    const titles={home:'全部内容',recent:'最近访问',favorites:'收藏',drafts:'本机草稿',trash:'回收站'};
    $('viewTitle').textContent=titles[currentRoute]||currentRoute.slice(9);$('headerContext').textContent=$('viewTitle').textContent;
    $('viewSubtitle').textContent=trashed?'可恢复文档，或永久删除不再需要的内容。':currentRoute==='drafts'?'草稿只在当前设备保存，发布后才会同步。':'阅读资料，也留下自己的理解。';
    document.querySelector('.guide-feature').hidden=!(currentRoute==='home'||currentRoute==='recent')||!!search;
    $('documentCount').textContent=items.length+' 条内容';
    visibleDocIds=items.map(d=>d.id);selectedIds=new Set([...selectedIds].filter(id=>visibleDocIds.includes(id)));if(search)selectedIds.clear();
    $('documentList').innerHTML=items.map(d=>{const href=d.type==='pdf'?pdfHash(d.id):noteHash(d.id),title=d.title||'未命名文档';const snippet=d.type==='pdf'?'PDF 参考资料':(d.body||'').replace(/[#*`>\[\]]/g,'').replace(/\s+/g,' ').slice(0,90)||'还没有正文';
      const actions=trashed?`<button class="restore" type="button" data-restore="${esc(d.id)}" aria-label="恢复文档：${esc(title)}">恢复</button><button class="doc-delete" type="button" data-permanent-delete="${esc(d.id)}" aria-label="永久删除文档：${esc(title)}">永久删除</button>`:`${d.type==='note'?`<button type="button" data-favorite="${esc(d.id)}" class="${d.favorite?'selected':''}" aria-label="${d.favorite?'取消收藏':'收藏'}">${d.favorite?'★':'☆'}</button>`:''}<button class="doc-delete" type="button" data-trash="${esc(d.id)}" aria-label="删除文档：${esc(title)}">删除</button>`;
      return `<div class="document-row"><input type="checkbox" data-select="${esc(d.id)}" aria-label="选择文档：${esc(title)}" ${selectedIds.has(d.id)?'checked':''}><a class="doc-main" href="${href}"><span class="file-icon ${d.type==='pdf'?'pdf-icon':'note-icon'}">${d.type==='pdf'?'PDF':'文'}</span><span class="doc-text"><strong>${esc(title)}${d.localDraft?'<span class="draft-badge">草稿</span>':''}</strong><small>${esc(snippet)}</small></span></a><span class="doc-notebook">${esc(d.notebook)}</span><span class="doc-date">${date(d.updated)}</span><span class="doc-actions">${actions}</span></div>`;}).join('');updateSelection();
    $('emptyState').hidden=items.length!==0;$('emptyState').querySelector('h2').textContent=search?'没有找到匹配内容':trashed?'回收站是空的':'在这里，留下你的理解';$('emptyState').querySelector('p').textContent=search?'尝试更短的关键词，或在指南内搜索具体内容。':trashed?'移入回收站的文档会显示在这里。':'新建一篇笔记，或导入已有的 Markdown 文件。';$('emptyNewButton').hidden=!!search||trashed;$('documentList').parentElement.hidden=items.length===0;
    markNavigation();reader.searchLibrary(items,search);if(deleting)setDocumentBusy(true);
  }
  function newNote(notebook='学习笔记',source=null,title='未命名笔记',body=''){
    const path='notes/'+uuid()+'.md',stamp=now(),note={id:path,path,sha:null,type:'note',title,notebook,body,created:stamp,updated:stamp,favorite:false,trashed:false,source};drafts[path]=note;persistDrafts();updateNotebooks();location.hash=noteHash(path);return note;
  }
  function setEditorMode(mode){editorMode=['read','edit','split'].includes(mode)?mode:'read';$('editorLayout').dataset.mode=editorMode;$('editorTools').hidden=editorMode==='read';document.querySelectorAll('[data-mode]').forEach(button=>{if(button.tagName==='BUTTON')button.classList.toggle('active',button.dataset.mode===editorMode);});}
  function renderPreview(){
    const html=marked.parse($('noteBody').value,{gfm:true,breaks:false});$('notePreview').innerHTML=DOMPurify.sanitize(html,{FORBID_TAGS:['iframe','form','style','script','object','embed'],FORBID_ATTR:['style']});
    $('notePreview').querySelectorAll('a').forEach(a=>{if(!a.getAttribute('href')?.startsWith('#')){a.target='_blank';a.rel='noopener noreferrer';}});
    $('notePreview').querySelectorAll('pre code').forEach(code=>{const requested=[...code.classList].find(c=>c.startsWith('language-'))?.slice(9);if(requested&&hljs.getLanguage(requested))code.innerHTML=hljs.highlight(code.textContent,{language:requested,ignoreIllegals:true}).value;});
    window.NoteHeatmap?.mount($('notePreview'));
    if(current?.type==='note')reader.mount(current);
    if(!$('noteBody').value.trim())$('notePreview').innerHTML='<p style="color:var(--subtle)">还没有正文，切换到编辑开始记录。</p>';
  }
  function showNote(note){
    current={...note};$('syncNotice').hidden=true;$('noteTitle').value=note.title;$('noteNotebook').value=note.notebook;$('noteBody').value=note.body;$('conflictPanel').hidden=true;
    $('saveStatus').textContent=drafts[note.id]?'草稿保存在此设备':'已发布到 GitHub';$('noteFavoriteButton').textContent=note.favorite?'★':'☆';$('noteFavoriteButton').setAttribute('aria-label',note.favorite?'取消收藏笔记':'收藏笔记');$('trashNoteButton').textContent=note.trashed?'恢复文档':'删除文档';
    $('noteFooter').textContent=(note.updated?'更新于 '+date(note.updated)+' · ':'')+'Markdown 笔记 · 发布后公开可见';$('headerContext').textContent=note.title;
    $('sourceReference').hidden=!note.source;if(note.source){const sourceLink=note.source.type==='pdf'?pdfHash(note.source.id):'#guide?anchor='+encodeURIComponent(note.source.hash||'');$('sourceReference').innerHTML=`关联资料：<a href="${sourceLink}">${esc(note.source.title||'驱动开发指南')}</a>`;}
    setEditorMode(drafts[note.id]?'edit':'read');renderPreview();addRecent(note.id);if(drafts[note.id]&&!note.body)$('noteTitle').focus();
  }
  async function saveCurrent(copy=false){
    if(!current||saving||deleting)return;if(!requireConnection())return;
    persistCurrent();let note={...current,title:$('noteTitle').value.trim()||'未命名笔记',notebook:$('noteNotebook').value.trim()||'学习笔记',body:$('noteBody').value,updated:now()};
    const submittedTitle=note.title;
    if(copy){const path='notes/'+uuid()+'.md';note={...note,id:path,path,sha:null,title:note.title+'（副本）',trashed:false,created:now()};}
    const priorId=current.id;saving=true;$('saveNoteButton').disabled=true;$('saveStatus').textContent='正在保存到 GitHub…';
    try{const saved=await store.save(note);documents=[...documents.filter(d=>d.id!==saved.id),saved];
      if(current?.id===priorId)persistCurrent();
      const latest=drafts[priorId],changed=latest&&(latest.body!==note.body||(latest.title.trim()||'未命名笔记')!==submittedTitle||latest.notebook!==note.notebook);
      if(changed){drafts[priorId]={...latest,sha:copy?latest.sha:saved.sha};}else delete drafts[priorId];
      if(copy)delete drafts[saved.id];persistDrafts();disk.write('cache',documents);
      if(current?.id===priorId){current=changed?{...drafts[priorId]}:saved;$('conflictPanel').hidden=true;if(!changed)$('noteTitle').value=saved.title;$('saveStatus').textContent=changed?'云端已保存，后续编辑仍保留为草稿':'已保存到 GitHub';$('headerContext').textContent=current.title;if(copy&&!changed)location.hash=noteHash(saved.id);}
      updateNotebooks();notify('已保存到 GitHub，其他设备可同步查看');}
    catch(error){if(current?.id===priorId){$('saveStatus').textContent='保存未完成，草稿已保留';if(error.status===409||error.status===422){$('conflictPanel').hidden=false;$('conflictLink').href=repoUrl+'/blob/'+encodeURIComponent(C.branch)+'/'+githubPath(note.path);}}notify(error.message);}
    finally{saving=false;$('saveNoteButton').disabled=false;}
  }
  async function changeNote(id,changes){
    if(deleting||saving){notify('正在保存或处理文档，请稍候。');return;}
    const note=allNotes().find(d=>d.id===id);if(!note||note.type!=='note')return;
    const next={...note,...changes,updated:now()};
    if(!note.sha){drafts[id]=next;persistDrafts();}
    else{if(!requireConnection())return;try{const saved=await store.save(next);documents=documents.map(d=>d.id===id?saved:d);if(drafts[id])drafts[id]={...drafts[id],...changes,sha:saved.sha};disk.write('cache',documents);persistDrafts();}catch(error){notify(error.message);return;}}
    updateNotebooks();if(current?.id===id){current={...current,...changes,sha:documents.find(d=>d.id===id)?.sha||null};$('noteFavoriteButton').textContent=current.favorite?'★':'☆';$('trashNoteButton').textContent=current.trashed?'恢复文档':'删除文档';}if(!$('libraryView').hidden)renderList();
  }
  function updateSelection(){
    $('selectionBar').hidden=selectedIds.size===0;$('selectionCount').textContent='已选择 '+selectedIds.size+' 份文档';$('batchTrashButton').textContent=currentRoute==='trash'?'恢复所选':'删除所选';$('batchTrashButton').disabled=deleting;
    $('batchPermanentDeleteButton').hidden=currentRoute!=='trash';$('batchPermanentDeleteButton').disabled=deleting;
    $('selectAllDocs').checked=visibleDocIds.length>0&&selectedIds.size===visibleDocIds.length;$('selectAllDocs').indeterminate=selectedIds.size>0&&selectedIds.size<visibleDocIds.length;
  }
  function notifyUndo(message,ids,trashed){notify(message);clearTimeout(toastTimer);$('undoTrashButton').hidden=false;$('undoTrashButton').onclick=()=>trashDocuments(ids,!trashed);toastTimer=setTimeout(()=>$('toast').hidden=true,10000);}
  function showDeleteDialog(docs,action){
    dialogDelete=action;const permanent=action.kind==='permanent';
    $('deleteDialogTitle').textContent=permanent?'永久删除这 '+docs.length+' 份文档？':'删除所选文档？';
    $('deleteDialogText').textContent=permanent?'将删除所列文档及此设备上的相关草稿，无法在网站中恢复。GitHub 提交历史仍会保留旧版本。':'将这 '+docs.length+' 份文档移入回收站，之后可以恢复。';
    $('confirmDeleteButton').textContent=permanent?'永久删除':'移入回收站';$('confirmDeleteButton').classList.toggle('danger',permanent);
    $('deleteDialogList').replaceChildren(...docs.map(d=>{const li=document.createElement('li');li.textContent=d.title||'未命名文档';return li;}));$('deleteDialog').showModal();$('cancelDeleteButton').focus();
  }
  function setDocumentBusy(value){document.querySelectorAll('[data-trash],[data-restore],[data-permanent-delete],[data-select],[data-favorite],#selectAllDocs,#batchTrashButton,#batchPermanentDeleteButton,#trashNoteButton,#trashPdfButton,#saveNoteButton,#noteFavoriteButton,#importButton,#refreshButton,#noteSync,#noteTitle,#noteNotebook,#noteBody,#newNoteButton,#emptyNewButton').forEach(b=>b.disabled=value);}
  function requestPermanentDelete(ids){
    if(deleting||saving){notify('正在保存或处理文档，请稍候。');return;}captureEditor();
    const docs=allNotes().filter(d=>ids.includes(d.id)&&d.trashed);if(!docs.length){notify('这些文档已不在回收站，请重新选择。');return;}
    if(docs.some(d=>d.type==='pdf'||documents.find(x=>x.id===d.id)?.sha)&&!store.token){pendingTrash={kind:'permanent',ids:docs.map(d=>d.id)};requireConnection();return;}
    const expected=Object.fromEntries(docs.map(d=>[d.id,{sha:documents.find(x=>x.id===d.id)?.sha||null,draft:JSON.stringify(drafts[d.id]||null)}]));
    showDeleteDialog(docs,{kind:'permanent',ids:docs.map(d=>d.id),expected});
  }
  async function permanentlyDeleteDocuments(ids,expected){
    if(deleting||saving){notify('正在保存或处理文档，请稍候。');return;}deleting=true;setDocumentBusy(true);
    try{
      if(refreshPromise)await refreshPromise;
      const targets=ids.map(id=>allNotes().find(d=>d.id===id));
      for(const target of targets){const version=target&&expected[target.id],published=target&&documents.find(d=>d.id===target.id);
        if(!target?.trashed||!version||(published&&!published.trashed)||(published?.sha||null)!==version.sha||JSON.stringify(drafts[target.id]||null)!==version.draft)throw new Error('文档已更新或恢复，未执行永久删除，请重新核对。');}
      const published=targets.map(d=>documents.find(x=>x.id===d.id)).filter(d=>d?.sha);
      if(published.length)await store.deleteDocuments(published);
      if(current&&ids.includes(current.id)){clearTimeout(draftTimer);clearTimeout(previewTimer);reader.leave();current=null;location.hash='#trash';if(pdfObjectUrl){URL.revokeObjectURL(pdfObjectUrl);pdfObjectUrl=null;$('pdfFrame').removeAttribute('src');}}
      documents=documents.filter(d=>!ids.includes(d.id));recent=recent.filter(id=>!ids.includes(id));
      for(const id of ids){delete drafts[id];selectedIds.delete(id);try{localStorage.removeItem('notebook.reading.'+id);}catch{}}
      persistDrafts();disk.write('cache',documents);disk.write('recent',recent);updateNotebooks();$('listStatus').textContent='';
      if(!$('libraryView').hidden)renderList();notify('已永久删除 '+targets.length+' 份文档');
    }catch(error){$('listStatus').textContent='永久删除未完成：'+error.message;notify('永久删除未完成：'+error.message);}
    finally{deleting=false;setDocumentBusy(false);updateSelection();}
  }
  function requestTrash(ids,trashed=true){
    if(deleting||saving){notify('正在保存或处理文档，请稍候。');return;}
    const docs=allNotes().filter(d=>ids.includes(d.id));if(!docs.length)return;
    if(trashed&&docs.length>1)showDeleteDialog(docs,{ids:docs.map(d=>d.id),trashed});
    else trashDocuments(docs.map(d=>d.id),trashed);
  }
  async function trashDocuments(ids,trashed,expected=null){
    if(deleting||saving){notify('正在保存或处理文档，请稍候。');return false;}captureEditor();
    const targets=allNotes().filter(d=>ids.includes(d.id)&&!!d.trashed!==trashed);if(!targets.length)return true;
    const versions=expected||Object.fromEntries(targets.map(d=>[d.id,(documents.find(x=>x.id===d.id)||d).sha||null]));
    if(targets.some(d=>d.type==='pdf'||documents.find(x=>x.id===d.id)?.sha)&&!store.token){pendingTrash={ids:targets.map(d=>d.id),trashed,expected:versions};requireConnection();return false;}
    deleting=true;const done=[],failed=[];
    setDocumentBusy(true);
    try{
      for(const target of targets){try{
        const published=documents.find(d=>d.id===target.id);
        if((published?.sha||null)!==(versions[target.id]||null))throw new Error('云端版本已变化，请同步并核对后重试。');
        let saved;
        if(target.type==='pdf'){saved=await store.setPdfTrashed(published||target,trashed);documents=documents.map(d=>d.id===target.id?saved:d);}
        else if(published?.sha){saved=await store.save({...published,trashed,updated:now()});documents=documents.map(d=>d.id===target.id?saved:d);if(drafts[target.id])drafts[target.id]={...drafts[target.id],trashed,sha:saved.sha};}
        else{drafts[target.id]={...drafts[target.id],...target,trashed,updated:now()};saved=drafts[target.id];}
        if(current?.id===target.id)current={...current,trashed,sha:saved.sha};selectedIds.delete(target.id);done.push(target.id);
      }catch(error){failed.push((target.title||'未命名文档')+'：'+error.message);}}
      persistDrafts();disk.write('cache',documents);updateNotebooks();
      if(current&&done.includes(current.id))location.hash=trashed?'#trash':'#home';else if(!$('libraryView').hidden)renderList();
      const message=(trashed?'已移入回收站 ':'已恢复 ')+done.length+' 份文档'+(failed.length?'；'+failed.length+' 份未完成。'+failed.join('；'):'');
      if(done.length)notifyUndo(message,done,trashed);else notify('操作未完成。'+failed.join('；'));
      return failed.length===0;
    }finally{deleting=false;setDocumentBusy(false);updateSelection();}
  }
  async function route(){
    captureEditor();reader.leave();const sequence=++routeSequence;
    const raw=location.hash.slice(1)||'home';const [path,query]=raw.split('?');const [kind,...rest]=path.split('/');let id;try{id=decodeURIComponent(rest.join('/'));}catch{location.hash='#home';return;}
    sidebar(!matchMedia('(max-width:850px)').matches&&!['note','guide'].includes(kind));
    for(const section of ['libraryView','guideView','noteView','pdfView'])$(section).hidden=true;
    current=null;currentRoute=kind==='notebook'?'notebook/'+id:kind;
    if(kind==='guide'){
      $('guideView').hidden=false;$('headerContext').textContent=guide.title;addRecent('guide');const anchor=new URLSearchParams(query||'').get('anchor')||'';
      const url=C.guide+'?embedded=1'+(anchor?(anchor.startsWith('#')?anchor:'#'+anchor):'');
      if(!$('guideFrame').getAttribute('src')||anchor)$('guideFrame').src=url;
      $('guideOpenLink').href=C.guide+(anchor?(anchor.startsWith('#')?anchor:'#'+anchor):'');markNavigation();return;
    }
    if(kind==='note'){
      let note=drafts[id]||documents.find(d=>d.id===id);
      if(!note&&refreshPromise){await refreshPromise;if(sequence!==routeSequence)return;note=drafts[id]||documents.find(d=>d.id===id);}
      if(!note){notify('这篇笔记尚未载入，正在同步内容。');location.hash='#home';refreshLibrary(true);return;}
      $('noteView').hidden=false;showNote(note);markNavigation();window.scrollTo(0,0);const params=new URLSearchParams(query||'');reader.open(note,{section:params.get('section'),query:params.get('q')});return;
    }
    if(kind==='pdf'){
      let file=documents.find(d=>d.id===id);if(!file&&refreshPromise){await refreshPromise;if(sequence!==routeSequence)return;file=documents.find(d=>d.id===id);}
      if(!file){location.hash='#home';return;}
      current=file;$('pdfView').hidden=false;$('pdfTitle').textContent=file.title;$('trashPdfButton').textContent=file.trashed?'恢复文档':'删除文档';$('headerContext').textContent=file.title;$('pdfStatus').textContent='正在载入 PDF…';$('pdfFrame').removeAttribute('src');addRecent(id);
      try{const url=await store.pdfUrl(file);if(sequence!==routeSequence){URL.revokeObjectURL(url);return;}if(pdfObjectUrl)URL.revokeObjectURL(pdfObjectUrl);pdfObjectUrl=url;$('pdfFrame').src=url;$('pdfStatus').textContent='';}catch(error){$('pdfStatus').textContent=error.message;}return;
    }
    if(!['home','recent','favorites','drafts','trash','notebook'].includes(kind)){location.hash='#home';return;}
    $('libraryView').hidden=false;renderList();markNavigation();window.scrollTo(0,0);
  }
  function exportCurrent(){if(!current)return;const body=$('noteBody').value;const title=$('noteTitle').value.trim()||'未命名笔记';download(new Blob(['# '+title+'\n\n'+body],{type:'text/markdown;charset=utf-8'}),title.replace(/[\/\\:*?"<>|]/g,'_')+'.md');}
  function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
  async function importFiles(files){
    const imported=[];
    for(const file of files){try{if(/\.pdf$/i.test(file.name)){if(!requireConnection())break;$('cloudStatus').textContent='正在上传 PDF…';await store.uploadPdf(file,uuid());await refreshLibrary(true);notify('PDF 已添加到资料库');}
      else if(/\.(md|markdown|txt)$/i.test(file.name)){if(file.size>1024*1024)throw new Error('文本笔记请控制在 1 MB 以内。');const text=await file.text(),path='notes/'+uuid()+'.md',base=NotebookGitHub.parseNote(text,{path,name:file.name,sha:null});const stamp=now();drafts[path]={...base,id:path,path,sha:null,created:stamp,updated:stamp};imported.push(path);}
      else throw new Error('暂时支持 Markdown、文本和 PDF 文件。');}catch(error){notify(file.name+'：'+error.message);}}
    persistDrafts();updateNotebooks();if(imported.length){notify('已导入 '+imported.length+' 篇草稿，可检查后保存到 GitHub');location.hash=noteHash(imported[0]);}else if(!$('libraryView').hidden)renderList();$('importInput').value='';
  }
  function format(kind){const area=$('noteBody'),start=area.selectionStart,end=area.selectionEnd,selected=area.value.slice(start,end);const templates={heading:['## ','','标题'],bold:['**','**','粗体文字'],italic:['*','*','斜体文字'],code:['\n```c\n','\n```\n','// 在这里写代码'],list:['- ','','列表内容'],link:['[','](https://)','链接文字']};const [prefix,suffix,fallback]=templates[kind];area.setRangeText(prefix+(selected||fallback)+suffix,start,end,'select');area.focus();area.dispatchEvent(new Event('input',{bubbles:true}));}
  $('repoLink').href=repoUrl;$('repoField').value=C.owner+'/'+C.repo;
  $('createTokenLink').href='https://github.com/settings/personal-access-tokens/new?name=My%20Notes&target_name='+encodeURIComponent(C.owner)+'&contents=write&expires_in=30';
  setTheme(theme,false);persistDrafts();updateNotebooks();
  $('themeSelect').onchange=e=>setTheme(e.target.value);
  $('menuButton').onclick=()=>sidebar(matchMedia('(max-width:850px)').matches?!$('sidebar').classList.contains('open'):document.body.classList.contains('compact'));
  $('backdrop').onclick=()=>sidebar(false);
  $('newNoteButton').onclick=$('emptyNewButton').onclick=()=>newNote(currentRoute.startsWith('notebook/')?currentRoute.slice(9):'学习笔记');
  $('refreshButton').onclick=()=>{captureEditor();$('listStatus').textContent='';refreshLibrary();};
  let librarySearchTimer;$('searchInput').oninput=()=>{clearTimeout(librarySearchTimer);librarySearchTimer=setTimeout(renderList,180);};$('noteSync').onclick=()=>refreshLibrary();$('sortSelect').onchange=renderList;
  $('newNotebookButton').onclick=()=>{$('notebookName').value='';$('notebookDialog').showModal();};
  $('notebookForm').onsubmit=e=>{e.preventDefault();const name=$('notebookName').value.trim();if(!name)return;$('notebookDialog').close();newNote(name);};
  $('connectButton').onclick=()=>{$('connectError').textContent='';$('connectDialog').showModal();};
  $('connectForm').onsubmit=async e=>{e.preventDefault();$('connectSubmit').disabled=true;$('connectError').textContent='';try{await store.connect($('tokenInput').value);$('tokenInput').value='';$('connectButton').textContent='已连接 GitHub';const action=pendingTrash;pendingTrash=null;$('connectDialog').close();notify('已连接，可保存笔记到 GitHub');await refreshLibrary(true);if(action){if(action.kind==='permanent')requestPermanentDelete(action.ids);else await trashDocuments(action.ids,action.trashed,action.expected);}}catch(error){$('connectError').textContent=error.message;}finally{$('connectSubmit').disabled=false;}};
  $('disconnectButton').onclick=()=>{store.disconnect();$('tokenInput').value='';$('connectButton').textContent='连接 GitHub';$('connectDialog').close();notify('已断开连接，草稿仍保留在此设备');};
  $('connectDialog').addEventListener('close',()=>{$('tokenInput').value='';pendingTrash=null;});
  $('helpButton').onclick=()=>$('helpDialog').showModal();
  $('importButton').onclick=()=>$('importInput').click();$('importInput').onchange=e=>importFiles([...e.target.files]);
  $('noteBody').oninput=()=>{if(!current)return;clearTimeout(draftTimer);clearTimeout(previewTimer);drafts[current.id]={...current};draftTimer=setTimeout(persistCurrent,350);previewTimer=setTimeout(renderPreview,120);};
  for(const id of ['noteTitle','noteNotebook'])$(id).oninput=()=>{if(current){drafts[current.id]={...current};clearTimeout(draftTimer);draftTimer=setTimeout(persistCurrent,350);}};
  $('saveNoteButton').onclick=()=>saveCurrent();$('saveCopyButton').onclick=()=>saveCurrent(true);$('downloadNoteButton').onclick=exportCurrent;
  $('noteFavoriteButton').onclick=()=>{captureEditor();if(current)changeNote(current.id,{favorite:!current.favorite});};
  $('trashNoteButton').onclick=$('trashPdfButton').onclick=()=>{if(current)requestTrash([current.id],!current.trashed);};
  $('guideDirectoryButton').onclick=()=>$('guideFrame').contentWindow.postMessage({type:'notebook-guide-directory'},location.origin);
  $('guideFrame').onload=()=>{$('guideFrame').dataset.loaded='true';syncGuideTheme();};
  $('guideNoteButton').onclick=()=>{let hash='',title=guide.title;try{const frame=$('guideFrame').contentWindow;hash=frame.location.hash;title=frame.document.getElementById('chapterTitle').textContent||guide.title;}catch{}newNote('Linux 驱动',{type:'guide',hash,title},title+' · 学习笔记');};
  $('pdfNoteButton').onclick=()=>{if(current)newNote('学习笔记',{type:'pdf',id:current.id,title:current.title},current.title+' · 阅读笔记');};
  document.addEventListener('click',e=>{
    const close=e.target.closest('[data-close]');if(close){$(close.dataset.close).close();return;}
    const favorite=e.target.closest('[data-favorite]');if(favorite){const note=allNotes().find(d=>d.id===favorite.dataset.favorite);if(note)changeNote(note.id,{favorite:!note.favorite});return;}
    const restore=e.target.closest('[data-restore]');if(restore){requestTrash([restore.dataset.restore],false);return;}
    const permanent=e.target.closest('[data-permanent-delete]');if(permanent){requestPermanentDelete([permanent.dataset.permanentDelete]);return;}
    const remove=e.target.closest('[data-trash]');if(remove){requestTrash([remove.dataset.trash],true);return;}
    const mode=e.target.closest('button[data-mode]');if(mode){setEditorMode(mode.dataset.mode);return;}
    const tool=e.target.closest('[data-format]');if(tool){format(tool.dataset.format);return;}
    if(e.target.closest('.skip')){e.preventDefault();$('main').focus();}
  });
  $('selectAllDocs').onchange=e=>{selectedIds=e.target.checked?new Set(visibleDocIds):new Set();for(const box of $('documentList').querySelectorAll('[data-select]'))box.checked=selectedIds.has(box.dataset.select);updateSelection();};
  $('documentList').addEventListener('change',e=>{const box=e.target.closest('[data-select]');if(!box)return;if(box.checked)selectedIds.add(box.dataset.select);else selectedIds.delete(box.dataset.select);updateSelection();});
  $('batchTrashButton').onclick=()=>requestTrash([...selectedIds],currentRoute!=='trash');$('clearSelectionButton').onclick=()=>{selectedIds.clear();for(const box of $('documentList').querySelectorAll('[data-select]'))box.checked=false;updateSelection();};
  $('batchPermanentDeleteButton').onclick=()=>requestPermanentDelete([...selectedIds]);
  $('confirmDeleteButton').onclick=()=>{const action=dialogDelete;dialogDelete=null;$('deleteDialog').close();if(action){if(action.kind==='permanent')permanentlyDeleteDocuments(action.ids,action.expected);else trashDocuments(action.ids,action.trashed);}};$('cancelDeleteButton').onclick=()=>{$('deleteDialog').close();dialogDelete=null;};$('deleteDialog').addEventListener('close',()=>dialogDelete=null);
  window.addEventListener('hashchange',route);
  window.addEventListener('pagehide',captureEditor);
  window.addEventListener('online',()=>refreshLibrary(true));
  window.addEventListener('focus',()=>{if(!saving)refreshLibrary(true);});
  window.addEventListener('resize',()=>{if(!matchMedia('(max-width:850px)').matches){$('backdrop').hidden=true;document.body.classList.remove('menu-open');$('sidebar').inert=document.body.classList.contains('compact');}else $('sidebar').inert=!$('sidebar').classList.contains('open');});
  document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='s'&&current?.type==='note'){e.preventDefault();saveCurrent();}});
  refreshLibrary(true);route();
})();
