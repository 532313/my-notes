/* Long-note navigation, local reading positions, and section search. */
(()=>{
  'use strict';
  const $=id=>document.getElementById(id),esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let note=null,heads=[],marks=[],hit=-1,timer,scrollTimer,navigating=false,lastPosition=null,cache=new Map();
  const gsytraceNotes=[
    'notes/gsytrace-overview.md',
    ...Array.from({length:8},(_,stage)=>'notes/gsytrace-m'+stage+'.md')
  ];
  const dockedOutline=matchMedia('(min-width:1100px)');
  let seriesDirectoryOpen=true,seriesArticle=null,seriesMarkup='';
  const fold=s=>s.toLowerCase().replace(/i²c|iic/g,'i2c');
  function pattern(q){const text=fold(q.trim()).replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/i2c/g,'(?:i2c|i²c|iic)');return text?new RegExp(text,'gi'):null;}
  function anchor(text,seen){let hash=2166136261;for(const c of text.trim())hash=Math.imul(hash^c.codePointAt(0),16777619);const base='s-'+(hash>>>0).toString(36),n=(seen.get(base)||0)+1;seen.set(base,n);return base+(n>1?'-'+n:'');}
  function outline(root){const seen=new Map();return [...root.querySelectorAll('h2,h3,h4')].filter(h=>h.textContent.trim()!=='目录').map(h=>({el:h,id:anchor(h.textContent,seen),text:h.textContent.trim(),level:Number(h.tagName[1])}));}
  function inset(){return document.querySelector('.app-header').getBoundingClientRect().height+document.querySelector('.reading-tools').getBoundingClientRect().height+14;}
  function visible(){return note&&!$('noteView').hidden&&$('editorLayout').dataset.mode!=='edit';}
  function position(){if(!visible())return null;let h=heads[0];for(const item of heads){if(item.el.getBoundingClientRect().top<=inset()+15)h=item;else break;}return h?{section:h.id,offset:scrollY-(h.el.getBoundingClientRect().top+scrollY),title:h.text}:null;}
  function remember(){if(navigating)return;const p=position();if(p)lastPosition=p;if(p)try{localStorage.setItem('notebook.reading.'+note.id,JSON.stringify(p));}catch{}}
  function stored(){try{return JSON.parse(localStorage.getItem('notebook.reading.'+note.id)||'null');}catch{return null;}}
  function restore(p){if(!p||!visible())return;const target=heads.find(h=>h.id===p.section);if(target)window.scrollTo({top:Math.max(0,target.el.getBoundingClientRect().top+scrollY+(p.offset??-inset())),behavior:'instant'});}
  function jump(id){restore({section:id,offset:-inset()});remember();if(!dockedOutline.matches&&$('outlinePanel').classList.contains('open')){$('outlineClose').click();}active();}
  function active(){
    if(!visible())return;
    const current=position();
    for(const link of $('outlinePanel').querySelectorAll('[data-jump],a[data-section]')){
      const selected=!!current&&(link.dataset.jump===current.section||
        (link.dataset.noteId===note.id&&link.dataset.section===current.section));
      link.classList.toggle('active',selected);
      if(selected)link.setAttribute('aria-current','location');
      else link.removeAttribute('aria-current');
    }
    $('readingProgress').textContent=current?.title||'';
    $('readingProgress').title=current?.title||'';
  }
  function clearMarks(){for(const m of marks){if(m.parentNode)m.replaceWith(document.createTextNode(m.textContent));}marks=[];hit=-1;$('notePreview').normalize();}
  function move(delta){if(!marks.length)return;if(hit>=0)marks[hit].classList.remove('current-match');hit=(hit+delta+marks.length)%marks.length;marks[hit].classList.add('current-match');marks[hit].scrollIntoView({block:'center',behavior:'instant'});$('findCount').textContent=(hit+1)+' / '+marks.length;}
  function find(jumpFirst=true){clearMarks();const re=pattern($('noteFind').value);if(!re){$('findCount').textContent='';return;}const walker=document.createTreeWalker($('notePreview'),NodeFilter.SHOW_TEXT);const nodes=[];while(walker.nextNode())if(!walker.currentNode.parentElement.closest('[hidden],.code-actions,button'))nodes.push(walker.currentNode);for(const node of nodes){re.lastIndex=0;const text=node.textContent;let m,last=0,fragment=null;while((m=re.exec(text))!==null){if(!fragment)fragment=document.createDocumentFragment();fragment.append(document.createTextNode(text.slice(last,m.index)));const mark=document.createElement('mark');mark.textContent=m[0];fragment.append(mark);marks.push(mark);last=m.index+m[0].length;}if(fragment){fragment.append(document.createTextNode(text.slice(last)));node.replaceWith(fragment);}}$('findCount').textContent=marks.length?'共 '+marks.length+' 处':'未找到匹配';if(jumpFirst)move(1);}
  function setOutline(open){
    $('outlinePanel').classList.toggle('open',open);
    $('outlineToggle').setAttribute('aria-expanded',String(open));
  }
  function shareButton(section){
    return '<button type="button" data-share="'+section.id+'" aria-label="复制章节链接：'+esc(section.text)+'" title="复制章节链接">↗</button>';
  }
  function updateSeries(documents){
    const series=$('outlineSeries');
    const list=$('outlineSeriesList');
    const id=note?.id??null;
    const available=new Map();
    if(id&&!note.trashed&&gsytraceNotes.includes(id)){
      for(const item of documents){
        if(item.type==='note'&&!item.trashed)available.set(item.id,item);
      }
    }
    const markup=gsytraceNotes.flatMap((itemId,index)=>{
      const item=available.get(itemId);
      if(!item)return [];
      const current=itemId===id;
      const label=index===0?'项目总览':item.title.replace(/^GsyTrace\s+/, '');
      const href='#note/'+encodeURIComponent(itemId);
      const title='<a class="outline-series-title" href="'+href+'"'+(current?' aria-current="page"':'')+'>'+esc(label)+'</a>';
      const sections=current?heads:markdownIndex(item.body||'').headings;
      if(!sections.length)return [title];
      const entries=sections.map(section=>{
        const link='<a href="'+href+'?section='+encodeURIComponent(section.id)+'" data-note-id="'+esc(itemId)+'" data-section="'+section.id+'">'+esc(section.text)+'</a>';
        return '<div class="outline-row outline-series-section level-'+section.level+'">'+link+(current?shareButton(section):'')+'</div>';
      }).join('');
      return ['<details data-note-id="'+esc(itemId)+'"><summary>'+title+'</summary>'+entries+'</details>'];
    }).join('');
    if(markup!==seriesMarkup||seriesArticle!==id){
      const expanded=seriesArticle===id
        ? new Set([...list.querySelectorAll('details[open]')].map(branch=>branch.dataset.noteId))
        : new Set([id]);
      list.innerHTML=markup;
      for(const branch of list.querySelectorAll('details'))branch.open=expanded.has(branch.dataset.noteId);
      seriesArticle=id;
      seriesMarkup=markup;
    }
    series.hidden=!markup;
    $('outlineList').hidden=!!markup;
    $('outlineToggle').hidden=!heads.length&&series.hidden;
    if($('outlineToggle').hidden)setOutline(false);
    active();
  }
  function mount(next,documents){note=next;const root=$('notePreview');heads=outline(root);for(const h of heads)h.el.id=h.id;const first=root.firstElementChild;if(first?.tagName==='H1'){first.hidden=true;$('noteReadTitle').title=first.textContent.trim()===next.title.trim()?'':'原文标题：'+first.textContent.trim();}else $('noteReadTitle').title='';for(const h of root.querySelectorAll('h2'))if(h.textContent.trim()==='目录'&&h.nextElementSibling?.tagName==='UL'){h.hidden=true;h.nextElementSibling.hidden=true;}
    updateSeries(documents);
    $('outlineList').innerHTML=heads.length?heads.map(h=>'<div class="outline-row level-'+h.level+'"><button type="button" data-jump="'+h.id+'">'+esc(h.text)+'</button>'+shareButton(h)+'</div>').join(''):'<p>添加二级或三级标题后，这里会生成目录。</p>';
    marks=[];hit=-1;if($('noteFind').value)find(false);active();}
  function open(next,opts={}){
    note=next;navigating=false;lastPosition=null;
    if(dockedOutline.matches&&!$('outlineSeries').hidden&&$('editorLayout').dataset.mode==='read')setOutline(seriesDirectoryOpen);
    $('noteFind').value=opts.query||'';$('noteFindPanel').open=!!opts.query;if(opts.query)find(false);else clearMarks();$('resumeReading').hidden=!stored();requestAnimationFrame(()=>requestAnimationFrame(()=>{if(note?.id!==next.id)return;if(opts.section)jump(opts.section);else restore(stored());active();remember();}));}
  function leave(){if(lastPosition&&note){try{localStorage.setItem('notebook.reading.'+note.id,JSON.stringify(lastPosition));}catch{}}else remember();note=null;seriesArticle=null;lastPosition=null;navigating=false;clearTimeout(timer);setOutline(false);}
  function highlight(text,q){const re=pattern(q);if(!re)return esc(text);let out='',last=0,m;while((m=re.exec(text))){out+=esc(text.slice(last,m.index))+'<mark>'+esc(m[0])+'</mark>';last=m.index+m[0].length;}return out+esc(text.slice(last));}
  function markdownIndex(body){
    if(cache.has(body))return cache.get(body);
    const box=document.createElement('div');
    box.innerHTML=DOMPurify.sanitize(marked.parse(body,{gfm:true}));
    const all=outline(box),byElement=new Map(all.map(heading=>[heading.el,heading]));
    const blocks=[];
    let title='正文',id='';
    for(const element of box.children){
      const heading=byElement.get(element);
      if(heading){title=heading.text;id=heading.id;}
      const isManualOutline=(element.tagName==='H2'&&element.textContent.trim()==='目录')||
        (element.tagName==='UL'&&element.previousElementSibling?.textContent.trim()==='目录');
      if(isManualOutline)continue;
      const text=element.textContent.replace(/\s+/g,' ').trim();
      if(text)blocks.push({title,id,text});
    }
    const index={headings:all.map(({id,text,level})=>({id,text,level})),blocks};
    if(cache.size>30)cache.clear();
    cache.set(body,index);
    return index;
  }
  function searchAction(doc){const restore=doc.trashed;return '<span class="doc-actions search-actions"><button type="button" class="'+(restore?'restore':'doc-delete')+'" '+(restore?'data-restore':'data-trash')+'="'+esc(doc.id)+'" aria-label="'+(restore?'恢复文档：':'删除文档：')+esc(doc.title)+'">'+(restore?'恢复':'删除')+'</button>'+(restore?'<button type="button" class="doc-delete" data-permanent-delete="'+esc(doc.id)+'" aria-label="永久删除文档：'+esc(doc.title)+'">永久删除</button>':'')+'</span>';}
  function searchLibrary(items,q){const panel=$('searchResults');panel.hidden=!q||!items.length;if(!q||!items.length)return;const re=pattern(q);let found=0,html='';for(const doc of items){if(doc.type==='pdf'){html+='<div class="search-result-row"><a class="search-result" href="#pdf/'+encodeURIComponent(doc.id)+'"><small>'+esc(doc.notebook)+' · PDF 参考资料</small><p>'+highlight(doc.title,q)+'</p></a>'+searchAction(doc)+'</div>';found++;continue;}if(doc.type!=='note')continue;let matches=[],seen=new Set();for(const b of markdownIndex(doc.body||'').blocks){re.lastIndex=0;const m=re.exec(b.text);if(!m)continue;re.lastIndex=0;const score=re.test(b.title)?100:0;const a=Math.max(0,m.index-55),end=Math.min(b.text.length,m.index+m[0].length+120);matches.push({...b,score,snippet:(a?'…':'')+b.text.slice(a,end)+(end<b.text.length?'…':'')});}matches=matches.sort((a,b)=>b.score-a.score).filter(b=>{if(seen.has(b.id))return false;seen.add(b.id);return true;}).slice(0,8);if(!matches.length)matches=[{id:'',title:'笔记标题或分类匹配',snippet:doc.title}];for(const b of matches){html+='<div class="search-result-row"><a class="search-result" href="#note/'+encodeURIComponent(doc.id)+'?section='+encodeURIComponent(b.id)+'&q='+encodeURIComponent(q)+'"><small>'+esc(doc.notebook)+' · '+esc(doc.title)+' → '+esc(b.title)+'</small><p>'+highlight(b.snippet,q)+'</p></a>'+searchAction(doc)+'</div>';found++;}}
    panel.innerHTML=html||'<p>没有找到匹配内容，请换一个关键词。</p>';$('documentCount').textContent=items.length+' 篇文档 · '+found+' 个定位结果';document.querySelector('.document-table').hidden=true;$('emptyState').hidden=true;}
  $('outlineToggle').onclick=()=>{
    const open=!$('outlinePanel').classList.contains('open');
    setOutline(open);
    if(dockedOutline.matches&&!$('outlineSeries').hidden)seriesDirectoryOpen=open;
  };
  $('outlineClose').onclick=()=>{
    setOutline(false);
    if(dockedOutline.matches&&!$('outlineSeries').hidden)seriesDirectoryOpen=false;
    $('outlineToggle').focus();
  };
  $('outlinePanel').onclick=async e=>{const b=e.target.closest('button');if(!b||!note)return;if(b.dataset.jump)jump(b.dataset.jump);if(b.dataset.share){const url=location.origin+location.pathname+'#note/'+encodeURIComponent(note.id)+'?section='+encodeURIComponent(b.dataset.share);try{await navigator.clipboard.writeText(url);$('readingMessage').textContent='章节链接已复制';}catch{$('shareLink').hidden=false;$('shareLink').value=url;$('shareLink').select();$('readingMessage').textContent='请复制下方链接';}}};
  $('noteFind').oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>find(),180);};$('noteFind').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();move(e.shiftKey?-1:1);}if(e.key==='Escape'){$('noteFind').value='';find(false);$('noteFindPanel').open=false;$('noteFindToggle').focus();}};$('findPrev').onclick=()=>move(-1);$('findNext').onclick=()=>move(1);$('findClear').onclick=()=>{$('noteFind').value='';find(false);$('noteFind').focus();};$('resumeReading').onclick=()=>restore(stored());$('readingTop').onclick=()=>window.scrollTo({top:0,behavior:'instant'});
  $('noteFindPanel').addEventListener('toggle',()=>{if($('noteFindPanel').open)$('noteFind').focus();});
  $('notePreview').addEventListener('click',e=>{const a=e.target.closest('a');const href=a?.getAttribute('href');if(href?.startsWith('#')&&heads.some(h=>h.id===href.slice(1))){e.preventDefault();jump(href.slice(1));}});
  document.addEventListener('click',e=>{
    if(!visible()||e.button!==0||e.ctrlKey||e.metaKey||e.shiftKey||e.altKey)return;
    const link=e.target.closest('a'),href=link?.getAttribute('href');
    if(link?.dataset.section&&link.dataset.noteId===note.id&&link.closest('#outlineSeriesList')){
      e.preventDefault();
      jump(link.dataset.section);
      return;
    }
    if(href?.startsWith('#')&&href!==location.hash&&!heads.some(h=>href==='#'+h.id)){remember();navigating=true;}
  },true);
  window.addEventListener('scroll',()=>{clearTimeout(scrollTimer);scrollTimer=setTimeout(()=>{active();remember();},200);},{passive:true});window.addEventListener('pagehide',remember);document.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&$('outlinePanel').classList.contains('open')&&
       (!dockedOutline.matches||e.target.closest?.('#outlinePanel, #outlineToggle')))$('outlineClose').click();
  });
  window.NoteReader={mount,open,leave,position,restore,remember,searchLibrary,fold,updateSeries};
})();
