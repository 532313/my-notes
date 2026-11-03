/* Offline handbook: scripts instead of fetch keep file:// browsing usable. */
(() => {
  'use strict';
  const C = window.BOOK_CATALOG;
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const norm = s => String(s || '').toLowerCase().replace(/\s/g, '');
  const storage = {get(key, fallback = null) {try {return JSON.parse(localStorage.getItem('rk3568.'+key)) ?? fallback;} catch {return fallback;}}, set(key,value) {try {localStorage.setItem('rk3568.'+key, JSON.stringify(value));} catch { /* Private/file browser storage can be unavailable. */ }}};
  if (!C) {$('overview').hidden=false;$('overview').textContent='目录资源加载失败。请将 HTML 与“3568阅读资源”文件夹放在一起后重新打开。';return;}
  const chapterMap = new Map(C.chapters.map(c => [c.id,c]));
  const bookmarkMap = new Map(C.bookmarks.map(b => [b.id,b]));
  const cache = new Map(), pending = new Map();
  let current = null, mode = storage.get('mode','reflow'), size = storage.get('font',17);
  let activePage = 1, observer = null, routeVersion = 0, last = storage.get('last'), searchIndex = null;
  let allHits = [], visibleHits = 0, searchTimer, loadIndexPromise, searchSequence = 0, saveTimer, toastTimer;
  let previousFocus = null;
  const systemTheme=window.matchMedia('(prefers-color-scheme: dark)');
  let themeMode=storage.get('themeMode','system');
  const sourceUrl = page => encodeURI(C.source)+'#page='+page;
  const originalUrl = page => '3568阅读资源/pages/p'+String(page).padStart(4,'0')+'.webp';
  const unitForPage = page => [...C.chapters].reverse().find(c => (c.start??c.page) <= page) || C.chapters[0];
  const queryString = q => q ? '?q='+encodeURIComponent(q) : '';
  const pageHash = (page,q='',unit=unitForPage(page)) => '#'+unit.id+'/p'+page+queryString(q);
  function unitForSearch(record,at) {
    const starts=C.chapters.filter(c=>c.number && c.page===record.page);
    if(!starts.length)return unitForPage(record.page);
    let owner=unitForPage(record.page);
    for(const unit of starts){
      const heading=record.normalized.indexOf(norm(unit.title));
      if(heading<0)continue;
      if(at>=heading){owner=unit;continue;}
      const part=C.parts.find(p=>p.id===unit.part);
      const partHeading=part?.page===record.page?record.normalized.indexOf(norm(part.title)):-1;
      owner=partHeading>=0&&at>=partHeading?unit:(C.chapters[C.chapters.indexOf(unit)-1]||unit);
      break;
    }
    return owner;
  }
  const showToast = message => {clearTimeout(toastTimer);$('toast').textContent=message;$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,2800);};

  window.Handbook = {
    register(data) {
      cache.set(data.id,data);
      if (pending.has(data.id)) {pending.get(data.id).resolve(data);pending.delete(data.id);}
      while (cache.size>5) {const first=cache.keys().next().value;if(first===current?.id){const item=cache.get(first);cache.delete(first);cache.set(first,item);}else cache.delete(first);}
    },
    setSearchIndex(records) {
      searchIndex=records.map(r=>({...r,normalized:norm(r.text)}));
      window.dispatchEvent(new Event('handbook-search-ready'));
    }
  };

  function loadChapter(id) {
    if(cache.has(id))return Promise.resolve(cache.get(id));
    if(pending.has(id))return pending.get(id).promise;
    let resolve,reject;
    const promise=new Promise((a,b)=>{resolve=a;reject=b;});
    pending.set(id,{promise,resolve,reject});
    const script=document.createElement('script');script.src='3568阅读资源/chapters/'+id+'.js';
    script.onload=()=>{script.remove();if(pending.has(id)){pending.delete(id);reject(new Error('章节资源未能正常读取'));}};
    script.onerror=()=>{script.remove();pending.delete(id);reject(new Error('章节资源加载失败，请检查“3568阅读资源”文件夹是否完整。'));};
    document.head.append(script);
    return promise;
  }

  function loadSearchIndex() {
    if(searchIndex)return Promise.resolve();
    if(loadIndexPromise)return loadIndexPromise;
    loadIndexPromise=new Promise((resolve,reject)=>{
      const ready=()=>{window.removeEventListener('handbook-search-ready',ready);resolve();};
      window.addEventListener('handbook-search-ready',ready);
      const script=document.createElement('script');script.src='3568阅读资源/search-index.js';
      script.onload=()=>{script.remove();if(!searchIndex){window.removeEventListener('handbook-search-ready',ready);loadIndexPromise=null;reject(new Error('搜索索引无法读取'));}};
      script.onerror=()=>{script.remove();window.removeEventListener('handbook-search-ready',ready);loadIndexPromise=null;reject(new Error('搜索索引加载失败'));};
      document.head.append(script);
    });
    return loadIndexPromise;
  }

  function buildNavigation() {
    const fronts=C.bookmarks.filter(b=>b.page<=41 && !/目录/.test(b.title));
    $('toc').innerHTML='<div class="front-links"><a href="#front">封面与原书目录</a>'+fronts.map(b=>`<a href="#${b.id}">${esc(b.title)}</a>`).join('')+'</div>'+C.parts.map((part,i)=>`<details class="part-node" id="nav-${part.id}"><summary><span class="part-number">${String(i+1).padStart(2,'0')}</span><span class="part-title">${esc(part.title.replace(/^第[一二三四五六七八九十百\d]+篇\s*/,''))}</span><span class="part-count">${part.chapters.length} 章</span></summary><div class="part-chapters">${part.chapters.map(id=>`<div class="chapter-node" data-chapter="${id}"><a href="#${id}">${esc(chapterMap.get(id).title)}</a><div class="toc-sections" hidden></div></div>`).join('')}</div></details>`).join('');
    $('overview').innerHTML=`<div class="overview-top"><span>本地文档 / 技术手册</span><a href="#b4">原书前言 ↗</a></div><header class="overview-hero"><div class="eyebrow">iTOP · RK3568 · LINUX</div><h1>驱动开发指南<span>重制版 V1.9</span></h1><p class="overview-desc">按原书篇章阅读 Linux 驱动基础与各子系统。查找函数、命令和实验步骤，随时切换原页核对图文。</p><div class="hero-bottom"><div class="hero-actions"><a href="#ch001" class="primary-link">开始阅读 <span aria-hidden="true">↗</span></a><a href="#b5" class="secondary-link">学习方法 →</a></div><div class="book-stats"><div class="stat"><strong>26</strong><span>主题篇</span></div><div class="stat"><strong>267</strong><span>章节</span></div></div></div></header><div class="contents-title"><h2>全书目录</h2><span>按原书顺序 · 点击展开章节</span></div><div class="parts-grid">${C.parts.map((part,i)=>`<details class="part-card"><summary><span class="part-index">${String(i+1).padStart(2,'0')}</span><div><h3>${esc(part.title.replace(/^第[一二三四五六七八九十百\d]+篇\s*/,''))}</h3><p>${part.chapters.length} 章</p></div></summary><div class="part-card-links"><a href="${pageHash(part.page)}">本篇首页 ↗</a>${part.chapters.map(id=>`<a href="#${id}">${esc(chapterMap.get(id).title)}</a>`).join('')}</div></details>`).join('')}</div><p class="overview-note">原文中的图、表、代码清单和配套资料路径均保留。代码由 PDF 提取，使用时可通过“原页”核对。<a href="#front/p38">版权声明 ↗</a></p>`;
  }

  function setActiveNavigation(unit,anchor) {
    document.querySelectorAll('.chapter-node>a.active').forEach(a=>{a.classList.remove('active');a.removeAttribute('aria-current');});
    document.querySelectorAll('.toc-sections').forEach(el=>{el.hidden=true;el.replaceChildren();});
    if(!unit)return;
    const node=document.querySelector(`.chapter-node[data-chapter="${unit.id}"]`);
    if(!node)return;
    const a=node.querySelector('a');a.classList.add('active');a.setAttribute('aria-current','page');
    const sections=unit.bookmarks.map(id=>bookmarkMap.get(id)).filter(b=>/^\d+\./.test(b.title));
    const pane=node.querySelector('.toc-sections');
    pane.innerHTML=sections.map(b=>`<a href="#${b.id}"${b.id===anchor?' aria-current="location"':''}>${esc(b.title)}</a>`).join('');pane.hidden=false;
    C.parts.forEach(p=>{$('nav-'+p.id).open=p.id===unit.part;});
    requestAnimationFrame(()=>{const nav=$('toc'),r=node.getBoundingClientRect(),nr=nav.getBoundingClientRect();if(r.top<nr.top||r.bottom>nr.bottom)nav.scrollTop+=r.top-nr.top-50;});
  }

  function toggleSidebar(open) {
    $('sidebar').classList.toggle('open',open);$('sidebarBackdrop').hidden=!open;
    $('menuButton').setAttribute('aria-expanded',String(open));document.body.classList.toggle('menu-open',open);
    if(!open && matchMedia('(max-width:780px)').matches && $('sidebar').contains(document.activeElement))$('menuButton').focus({preventScroll:true});
    $('sidebar').inert=matchMedia('(max-width:780px)').matches&&!open;
  }

  function parseRoute() {
    const [fragment,query]=location.hash.slice(1).split('?');
    const [id,part]=fragment.split('/');
    const parameters=new URLSearchParams(query||'');
    const q=parameters.get('q')||'',resume=parameters.get('resume')==='1';
    if(!id||id==='overview')return {overview:true,q};
    let anchor=id,page;
    let unit=chapterMap.get(id);
    if(bookmarkMap.has(id)){const b=bookmarkMap.get(id);unit=chapterMap.get(b.chapter);page=b.page;}
    if(/^p\d+$/.test(id)){page=Number(id.slice(1));unit=unitForPage(page);anchor='p'+page;}
    if(/^p\d+$/.test(part||'')){page=Number(part.slice(1));anchor='p'+page;}
    if(!unit)return {overview:true,invalid:true,q};
    if(page && (page<1||page>C.pages))return {overview:true,invalid:true,q};
    return {unit,anchor,page:page||unit.page,q,resume};
  }

  function pageMarkup(page) {
    return `<article class="page-card" id="p${page.n}" data-page="${page.n}"><header class="page-bar"><div>原书页码<strong>${page.n}</strong></div><div class="page-bar-actions"><button type="button" data-original="${page.n}">核对原页</button><a href="${sourceUrl(page.n)}" target="_blank" rel="noopener">原 PDF ↗</a><button type="button" data-link="${page.n}" aria-label="复制第 ${page.n} 页链接">⌁</button></div></header><div class="page-content">${page.html}</div><div class="original-page" hidden></div></article>`;
  }

  function prepareSequenceCopy() {
    const blocks=[...$('chapterContent').querySelectorAll('.code-box:not([hidden])')];
    blocks.forEach((box,i)=>{
      const sequence=[box];let previous=box;
      for(let j=i+1;j<blocks.length;j++){
        const next=blocks[j];const prevPage=Number(previous.closest('.page-card').dataset.page),nextPage=Number(next.closest('.page-card').dataset.page);
        if(nextPage===prevPage+1 && next.dataset.contiguous!=='false' && previous.dataset.contiguous!=='false' && Number(next.dataset.start)===Number(previous.dataset.end)+1){sequence.push(next);previous=next;}else break;
      }
      if(sequence.length>1){const b=document.createElement('button');b.type='button';b.className='copy-sequence';b.textContent='复制完整代码';b.setAttribute('aria-label',`复制当前代码及后续 ${sequence.length-1} 个片段`);box.querySelector('.code-bar').append(b);b.addEventListener('click',()=>copyText(sequence.map(codeText).join('\n'),b));}
    });
  }

  // Shared source pages can contain two chapters. Show only this chapter's
  // content in the continuous view; the optional original image stays intact.
  function trimChapterBoundaries(unit) {
    $('chapterContent').querySelectorAll('.code-bar>span').forEach(label=>{label.textContent=label.textContent.replace(' · 跨页续接',' · 续');});
    if(!unit.number)return;
    const cards=[...$('chapterContent').querySelectorAll('.page-card')];
    const headings=cards.flatMap(card=>[...card.querySelectorAll('.book-heading')]);
    const part=C.parts.find(p=>p.id===unit.part);
    const partStart=part?.page===unit.start;
    const first=headings.find(el=>norm(el.textContent)===norm(partStart?part.title:unit.title));
    if(first){
      let node=first.previousElementSibling;
      while(node){const previous=node.previousElementSibling;if(!node.classList.contains('bookmark-anchor') || !unit.bookmarks.includes(node.id))node.hidden=true;node=previous;}
    }
    const next=C.chapters[C.chapters.indexOf(unit)+1];
    if(next){
      const nextPart=next.part!==unit.part?C.parts.find(p=>p.id===next.part):null;
      const boundary=headings.find(el=>norm(el.textContent)===norm(nextPart?.title)||norm(el.textContent)===norm(next.title));
      if(boundary){for(let node=boundary;node;node=node.nextElementSibling)node.hidden=true;}
    }
  }

  function mergePageContinuations() {
    const cards=[...$('chapterContent').querySelectorAll('.page-card')];
    const visibleChildren=card=>[...card.querySelector('.page-content').children].filter(el=>!el.hidden&&!el.classList.contains('bookmark-anchor'));
    for(let i=1;i<cards.length;i++){
      let before;
      for(let j=i-1;j>=0&&!before;j--)before=visibleChildren(cards[j]).at(-1);
      const after=visibleChildren(cards[i])[0];
      if(!before||!after)continue;
      const sourcePage=cards[i].dataset.page;
      if(before.classList.contains('code-box')&&after.classList.contains('code-box')&&before.dataset.contiguous!=='false'&&after.dataset.contiguous!=='false'&&Number(after.dataset.start)===Number(before.dataset.end)+1){
        const destination=before.querySelector('code');
        after.querySelectorAll('.code-line').forEach(line=>{line.dataset.sourcePage=sourcePage;destination.append(line);});
        before.dataset.end=after.dataset.end;after.hidden=true;
      }else if(before.classList.contains('body-copy')&&after.classList.contains('body-copy')&&!/[。！？!?；;：:]\s*$/.test(before.textContent)){
        const continuation=document.createElement('span');continuation.dataset.sourcePage=sourcePage;
        if(/[A-Za-z0-9]$/.test(before.textContent)&&/^[A-Za-z0-9]/.test(after.textContent))before.append(' ');
        while(after.firstChild)continuation.append(after.firstChild);
        before.append(continuation);after.hidden=true;
      }
    }
  }

  async function renderRoute() {
    const revision=++routeVersion,route=parseRoute();
    document.body.dataset.readerReady='false';
    toggleSidebar(false);clearTimeout(saveTimer);observer?.disconnect();
    if(route.overview){current=null;$('overview').hidden=false;$('chapterView').hidden=true;$('pageDock').hidden=true;$('readingProgress').hidden=true;setActiveNavigation(null);document.title=C.title+' · 离线阅读版';window.scrollTo(0,0);if(route.invalid)showToast('该位置不存在，已返回全书目录。');document.body.dataset.readerReady='true';return;}
    $('overview').hidden=true;$('chapterView').hidden=false;$('pageDock').hidden=false;$('readingProgress').hidden=false;
    const {unit}=route,same=current?.id===unit.id;
    current=unit;setActiveNavigation(unit,route.anchor);
    const part=C.parts.find(p=>p.id===unit.part);
    $('breadcrumbs').innerHTML=`<a href="#overview">全书总览</a><span>/</span>${esc(part?.title||'原书附录与说明')}`;
    $('chapterKicker').textContent=unit.number?'CHAPTER '+String(unit.number).padStart(3,'0'):'READING GUIDE';
    $('chapterTitle').textContent=unit.title;
    $('chapterRange').textContent=unit.number?'按章节连续阅读':'原书说明';
    $('chapterPdf').href=sourceUrl(unit.page);
    document.title=unit.title+' · '+C.title;
    const sections=unit.bookmarks.map(id=>bookmarkMap.get(id)).filter(b=>/^\d+\./.test(b.title));
    $('sectionCount').textContent=String(sections.length);$('chapterOutline').hidden=sections.length===0;
    $('sectionLinks').innerHTML=sections.map(b=>`<a href="#${b.id}">${esc(b.title)}</a>`).join('');
    const position=C.chapters.indexOf(unit),prev=C.chapters[position-1],next=C.chapters[position+1];
    for(const [id,item,label] of [['prevChapter',prev,'← 上一章'],['nextChapter',next,'下一章 →']]){const a=$(id);a.hidden=!item;if(item){a.href='#'+item.id;a.innerHTML=`<small>${label}</small>${esc(item.title)}`;}}
    if(!same){$('chapterContent').replaceChildren();$('chapterStatus').textContent='正在载入本章…';window.scrollTo(0,0);}
    try {
      if(!same){const data=await loadChapter(unit.id);if(revision!==routeVersion)return;$('chapterContent').innerHTML=data.pages.map(pageMarkup).join('');trimChapterBoundaries(unit);mergePageContinuations();colorizeCode();prepareSequenceCopy();}
      if(revision!==routeVersion)return;
      $('chapterStatus').textContent='';setMode(mode,false);clearHighlights();
      if(route.q)highlightPage(route.page,route.q);
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      if(revision!==routeVersion)return;
      let target=document.getElementById(route.anchor);
      if(!target && /^ch\d+/.test(route.anchor)){
        target=[...$('chapterContent').querySelectorAll('.book-heading')].find(el=>norm(el.textContent)===norm(unit.title));
      }
      if(mode==='original' && target)target=target.closest('.page-card')||target;
      if(route.resume && last?.chapter===unit.id && Number.isFinite(last.scrollY))window.scrollTo(0,last.scrollY);
      else if(target){target.scrollIntoView({block:'start'});if(route.q&&mode==='reflow')$('chapterContent').querySelector('mark.search-hit')?.scrollIntoView({block:'center'});}
      else window.scrollTo(0,0);
      if(route.q&&mode==='original')showToast('已定位到搜索结果所在原页；切换“阅读排版”可查看高亮。');
      activePage=route.page;updateDock(activePage);observePages();savePosition();
      document.body.dataset.readerReady='true';
      // Deep links remain usable even when the search panel has not been opened yet.
      if(route.q&&!$('searchInput').value)$('searchInput').value=route.q;
    }catch(error){if(revision!==routeVersion)return;$('chapterStatus').textContent=error.message;const retry=document.createElement('button');retry.textContent='重试加载';retry.type='button';retry.onclick=()=>{current=null;renderRoute();};$('chapterStatus').append(' ',retry);}
  }

  function setMode(value,preserve=true) {
    const previous=$('p'+activePage),top=preserve&&previous?previous.getBoundingClientRect().top:null;
    mode=value;storage.set('mode',mode);
    $('reflowMode').setAttribute('aria-pressed',String(mode==='reflow'));$('originalMode').setAttribute('aria-pressed',String(mode==='original'));
    $('chapterContent').querySelectorAll('.page-card').forEach(card=>{
      const original=card.querySelector('.original-page'),n=Number(card.dataset.page);
      card.classList.toggle('original-mode',mode==='original');original.hidden=mode!=='original';
      if(mode==='original'&&!original.hasChildNodes())original.innerHTML=`<button type="button" class="zoom-image" aria-label="放大原书第 ${n} 页"><img src="${originalUrl(n)}" width="1072" height="1516" loading="lazy" decoding="async" alt="原书第 ${n} 页完整图像"></button>`;
    });
    if(top!==null)requestAnimationFrame(()=>window.scrollBy(0,previous.getBoundingClientRect().top-top));
  }

  function updateDock(n) {
    $('currentPage').textContent=`第 ${n} / ${C.pages} 页`;
    if(document.activeElement!==$('pageInput'))$('pageInput').value=n;
    updateProgress();
  }

  function updateProgress(){const total=document.documentElement.scrollHeight-innerHeight;$('readingProgress').firstElementChild.style.width=(total>0?Math.min(100,Math.max(0,window.scrollY/total*100)):0).toFixed(2)+'%';}

  function observePages() {
    observer?.disconnect();
    observer=new IntersectionObserver(entries=>{
      const visible=[...$('chapterContent').querySelectorAll('.page-card')].filter(el=>{const r=el.getBoundingClientRect();return r.top<innerHeight*.6&&r.bottom>100;});
      const chosen=visible.find(el=>el.getBoundingClientRect().bottom>170)||visible[0];
      if(chosen){activePage=Number(chosen.dataset.page);updateDock(activePage);clearTimeout(saveTimer);saveTimer=setTimeout(savePosition,350);}
    },{rootMargin:'-90px 0px -30% 0px',threshold:[0,.05,.25,.5]});
    $('chapterContent').querySelectorAll('.page-card').forEach(el=>observer.observe(el));
  }

  function savePosition() {
    if(!current)return;
    last={chapter:current.id,page:activePage,title:current.title,scrollY:window.scrollY};storage.set('last',last);updateResume();
  }
  function updateResume() {
    $('resumeButton').hidden=!last||!chapterMap.has(last.chapter);
    if(last)$('resumeButton').title=last.title;
  }

  function clearHighlights(){document.querySelectorAll('mark.search-hit').forEach(mark=>{const p=mark.parentNode;mark.replaceWith(document.createTextNode(mark.textContent));p.normalize();});}
  function highlightPage(page,query) {
    const container=$('p'+page)?.querySelector('.page-content'),q=norm(query);
    if(!container||!q)return;
    const points=[],nodes=[];let flat='',node;
    const roots=[...$('chapterContent').querySelectorAll(`[data-source-page="${page}"]`),container].sort((a,b)=>a===b?0:(a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING?-1:1));
    for(const root of roots){const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode(n){const origin=n.parentElement.closest('[data-source-page]');return n.parentElement.closest('[hidden],.line-no,.code-bar,.code-note,button,.caption')||(origin&&origin.dataset.sourcePage!==String(page))?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT;}});
      while((node=walker.nextNode())){const index=nodes.push(node)-1;for(let offset=0;offset<node.textContent.length;offset++){const ch=node.textContent[offset];if(/\s/.test(ch))continue;const lower=ch.toLowerCase();flat+=lower;for(let j=0;j<lower.length;j++)points.push({index,offset});}}}
    const ranges=new Map();let from=0,count=0;
    while(count<30){const at=flat.indexOf(q,from);if(at<0)break;for(let i=at;i<at+q.length;i++){const {index,offset}=points[i];if(!ranges.has(index))ranges.set(index,[]);const rs=ranges.get(index),end=rs[rs.length-1];if(end&&offset<=end[1])end[1]=offset+1;else rs.push([offset,offset+1]);}from=at+q.length;count++;}
    for(const [index,rs] of ranges){const text=nodes[index].textContent,fragment=document.createDocumentFragment();let offset=0;for(const [start,end] of rs){fragment.append(text.slice(offset,start));const mark=document.createElement('mark');mark.className='search-hit';mark.textContent=text.slice(start,end);fragment.append(mark);offset=end;}fragment.append(text.slice(offset));nodes[index].replaceWith(fragment);}
  }

  function rawOffset(text,index) {let n=0;for(let i=0;i<text.length;i++){if(!/\s/.test(text[i])){if(n===index)return i;n+=text[i].toLowerCase().length;}}return text.length;}
  function appendResults() {
    const query=$('searchInput').value,q=norm(query),batch=allHits.slice(visibleHits,visibleHits+35),fragment=document.createDocumentFragment();
    for(const {record,at} of batch){
      const start=rawOffset(record.text,at),end=rawOffset(record.text,at+q.length),lo=Math.max(0,start-34),hi=Math.min(record.text.length,end+65),unit=unitForSearch(record,at);
      const a=document.createElement('a');a.className='search-result';a.href=pageHash(record.page,query,unit);
      a.innerHTML=`<span class="result-title">${esc(unit.title)}</span><span class="result-snippet">${lo?'…':''}${esc(record.text.slice(lo,start))}<mark>${esc(record.text.slice(start,end))}</mark>${esc(record.text.slice(end,hi))}${hi<record.text.length?'…':''}</span>`;
      fragment.append(a);
    }
    $('searchResults').append(fragment);visibleHits+=batch.length;$('moreResults').hidden=visibleHits>=allHits.length;
    if(visibleHits<allHits.length)$('moreResults').textContent=`显示更多（${visibleHits} / ${allHits.length} 条）`;
  }

  async function search() {
    const revision=++searchSequence,query=$('searchInput').value,q=norm(query);
    $('searchResults').replaceChildren();$('moreResults').hidden=true;$('searchRetry').hidden=true;
    if(!q){$('searchPanel').hidden=true;$('searchStatus').textContent='支持中英文全文检索';clearHighlights();return;}
    $('searchPanel').hidden=false;$('searchStatus').textContent=searchIndex?'正在检索…':'正在载入离线全文索引…';
    try{await loadSearchIndex();if(revision!==searchSequence)return;allHits=[];for(const record of searchIndex){const at=record.normalized.indexOf(q);if(at>=0)allHits.push({record,at});}visibleHits=0;$('searchStatus').textContent=allHits.length?`找到 ${allHits.length} 条结果 · 点击定位并高亮`:'没有找到匹配内容，可尝试更短的关键词';appendResults();}catch(error){if(revision!==searchSequence)return;$('searchStatus').textContent=error.message+'，请检查资源文件夹。';$('searchRetry').hidden=false;}
  }

  function colorizeCode() {
    if(!window.CodeSyntax)return;
    $('chapterContent').querySelectorAll('.code-box:not([hidden])').forEach(box=>window.CodeSyntax.highlight(box));
  }

  function codeText(box){return [...box.querySelectorAll('.source-line')].map(l=>l.textContent).join('\n');}
  async function copyText(text,button) {
    let success=false;
    try{await navigator.clipboard.writeText(text);success=true;}catch{
      const area=document.createElement('textarea');area.value=text;area.style.cssText='position:fixed;top:0;left:-9999px';document.body.append(area);area.select();try{success=document.execCommand('copy');}catch{}area.remove();
    }
    if(success){if(button){const label=button.textContent;button.textContent='已复制';setTimeout(()=>{button.textContent=label;},1300);}showToast('已复制');}
    else{showToast('浏览器未允许复制，已选中文本，请使用 ⌘C / Ctrl+C。');if(button){const target=button.closest('.code-box')?.querySelector('code');if(target){const range=document.createRange();range.selectNodeContents(target);getSelection().removeAllRanges();getSelection().addRange(range);}}}
  }

  function openImage(src,alt) {
    previousFocus=document.activeElement;$('dialogImage').src=src;$('dialogImage').alt=alt;$('dialogImage').classList.remove('actual-size');$('zoomToggle').textContent='实际大小';$('imageTitle').textContent=alt;$('openImage').href=src;$('imageDialog').showModal();
  }
  function toggleZoom(){const actual=$('dialogImage').classList.toggle('actual-size');$('zoomToggle').textContent=actual?'适应窗口':'实际大小';}
  function setFont(value){size=Math.min(23,Math.max(14,Number(value)||17));document.documentElement.style.setProperty('--reader-font',size+'px');$('fontSize').textContent=size;storage.set('font',size);}
  function setTheme(mode,persist=true){
    themeMode=['system','light','dark'].includes(mode)?mode:'system';
    const dark=themeMode==='dark'||(themeMode==='system'&&systemTheme.matches);
    document.documentElement.classList.toggle('dark',dark);
    document.documentElement.dataset.theme=themeMode;
    $('themeSelect').value=themeMode;
    if(persist)storage.set('themeMode',themeMode);
  }
  systemTheme.addEventListener('change',()=>{if(themeMode==='system')setTheme('system',false);});

  buildNavigation();setFont(size);setTheme(themeMode,false);updateResume();
  $('menuButton').onclick=()=>toggleSidebar(!$('sidebar').classList.contains('open'));
  $('sidebarBackdrop').onclick=()=>toggleSidebar(false);
  $('collapseToc').onclick=()=>document.querySelectorAll('#toc details').forEach(el=>el.open=false);
  $('themeSelect').onchange=event=>setTheme(event.target.value);
  $('smaller').onclick=()=>setFont(size-1);$('larger').onclick=()=>setFont(size+1);
  $('reflowMode').onclick=()=>setMode('reflow');$('originalMode').onclick=()=>setMode('original');
  $('resumeButton').onclick=()=>{if(last){const hash=Number.isFinite(last.scrollY)?'#'+last.chapter+'?resume=1':'#'+last.chapter+'/p'+last.page;if(location.hash===hash)renderRoute();else location.hash=hash;}};
  $('toTop').onclick=()=>window.scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'instant':'smooth'});
  $('pageForm').onsubmit=e=>{e.preventDefault();const n=Number($('pageInput').value);if(!Number.isInteger(n)||n<1||n>C.pages){showToast('请输入 1–2080 之间的页码。');return;}location.hash=pageHash(n);};
  $('searchInput').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(search,160);};
  $('searchInput').onkeydown=async e=>{if(e.key==='Enter'){e.preventDefault();clearTimeout(searchTimer);await search();const first=$('searchResults').querySelector('a');first?.click();}};
  $('clearSearch').onclick=()=>{$('searchInput').value='';search();$('searchInput').focus();};
  $('moreResults').onclick=appendResults;$('searchRetry').onclick=search;
  $('closeImage').onclick=()=>$('imageDialog').close();$('imageDialog').addEventListener('close',()=>{previousFocus?.focus({preventScroll:true});$('dialogImage').removeAttribute('src');});
  $('zoomToggle').onclick=toggleZoom;$('dialogImage').onclick=toggleZoom;
  $('helpButton').onclick=()=>$('helpDialog').showModal();$('closeHelp').onclick=()=>$('helpDialog').close();
  for(const id of ['imageDialog','helpDialog'])$(id).addEventListener('click',e=>{if(e.target===$(id)){const r=$(id).getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$(id).close();}});
  document.addEventListener('keydown',e=>{
    const editing=/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)||document.activeElement.isContentEditable;
    if(e.key==='/'&&!editing&&!$('imageDialog').open&&!$('helpDialog').open){e.preventDefault();if(matchMedia('(max-width:780px)').matches)toggleSidebar(true);$('searchInput').focus();}
    if(e.key==='Escape'&&!$('imageDialog').open&&!$('helpDialog').open){if(!$('searchPanel').hidden){$('searchInput').value='';search();}else toggleSidebar(false);}
  });
  document.addEventListener('click',e=>{
    if(e.target.closest('.skip-link')){e.preventDefault();$('main').focus();return;}
    const copy=e.target.closest('.copy-code');if(copy){copyText(codeText(copy.closest('.code-box')),copy);return;}
    const original=e.target.closest('[data-original]');if(original){const n=Number(original.dataset.original);openImage(originalUrl(n),'原书第 '+n+' 页');return;}
    const image=e.target.closest('.zoom-image');if(image){const img=image.querySelector('img');openImage(img.src,img.alt);return;}
    const link=e.target.closest('[data-link]');if(link){copyText(location.href.split('#')[0]+pageHash(Number(link.dataset.link)),null);return;}
    const a=e.target.closest('a[href^="#"]');if(a){if(a.closest('#searchResults')){$('searchPanel').hidden=true;toggleSidebar(false);}if(a.hash===location.hash){e.preventDefault();renderRoute();}}
  });
  // Delayed images reserve dimensions; failures are surfaced instead of silently disappearing.
  document.addEventListener('error',e=>{if(e.target.tagName==='IMG' && e.target.closest('#chapterContent')){const warning=document.createElement('p');warning.className='empty-page';warning.textContent='图像未能载入，请检查资源文件夹，或使用本页“原 PDF”链接。';e.target.parentElement.after(warning);}},true);
  window.addEventListener('hashchange',renderRoute);
  window.addEventListener('scroll',()=>{if(current && document.body.dataset.readerReady==='true'){updateProgress();clearTimeout(saveTimer);saveTimer=setTimeout(savePosition,350);}},{passive:true});
  window.addEventListener('resize',()=>{$('sidebar').inert=matchMedia('(max-width:780px)').matches&&!$('sidebar').classList.contains('open');});
  window.addEventListener('pagehide',()=>{clearTimeout(saveTimer);savePosition();});
  renderRoute();
})();

window.addEventListener('message',event=>{if(event.source!==window.parent||event.origin!==location.origin||event.data?.type!=='notebook-theme')return;const select=document.getElementById('themeSelect');if(select&&['system','light','dark'].includes(event.data.mode)){select.value=event.data.mode;select.dispatchEvent(new Event('change'));}});
