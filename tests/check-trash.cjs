// Run: NOTEBOOK_JSDOM=/path/to/jsdom node tests/check-trash.cjs
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {JSDOM,VirtualConsole}=require(process.env.NOTEBOOK_JSDOM||'jsdom');
const root=path.resolve(__dirname,'..'),checks=[];
const hash=text=>crypto.createHash('sha1').update(text).digest('hex');
const json=(data,status=200)=>new Response(JSON.stringify(data),{status});
const stamp='2026-11-05T00:00:00.000Z';
function note(name,trashed=true){const id='notes/'+name+'.md';return {id,path:id,type:'note',title:name,notebook:'测试',body:'## '+name+'\n\n测试正文',created:stamp,updated:stamp,trashed,favorite:false};}
const serialize=n=>'<!-- notebook: '+JSON.stringify({...n,version:1})+' -->\n\n'+n.body;
class Repo{
  constructor(){this.snapshots=new Map();this.trees=new Map();this.commits=new Map();this.calls=[];this.seq=0;this.beforePatch=null;this.failStage='';this.publish(new Map());}
  publish(files){const tree='tree-'+(++this.seq),commit='commit-'+this.seq;this.trees.set(tree,new Map(files));this.commits.set(commit,{tree:{sha:tree},parents:[this.head]});this.snapshots.set(commit,new Map(files));this.head=commit;}
  get files(){return this.snapshots.get(this.head);}
  put(key,text){const files=new Map(this.files);files.set(key,{text,sha:hash(text)});this.publish(files);}
  seed(){for(const n of [note('回收笔记'),note('正常笔记',false)])this.put(n.path,serialize(n));this.put('documents/过期资料.pdf','%PDF-1.4\nold');this.put('documents/保留资料.pdf','%PDF-1.4\nkeep');this.put('documents/.trash.json',JSON.stringify({version:1,files:{'documents/过期资料.pdf':{sha:this.files.get('documents/过期资料.pdf').sha,trashed:true},'documents/保留资料.pdf':{sha:this.files.get('documents/保留资料.pdf').sha,trashed:true}}}));this.put('index.html','keep website');}
  async fetch(input,options={}){
    const url=new URL(input,'https://532313.github.io/my-notes/'),method=options.method||'GET';
    if(url.hostname==='raw.githubusercontent.com'){const parts=decodeURIComponent(url.pathname).split('/'),ref=parts[3],key=parts.slice(4).join('/'),file=(this.snapshots.get(ref)||this.files).get(key);return file?new Response(file.text):new Response('',{status:404});}
    if(url.pathname.endsWith('/bootstrap.json'))return json([]);
    assert.equal(url.hostname,'api.github.com');const endpoint=decodeURIComponent(url.pathname.replace('/repos/532313/my-notes',''));this.calls.push({endpoint,method,body:options.body&&JSON.parse(options.body)});
    if(method!=='GET'&&!options.headers?.Authorization)return json({},401);
    if(this.failStage===endpoint&&method!=='GET')return json({},403);
    if(!endpoint)return json({owner:{login:'532313'},permissions:{push:true}});
    if(endpoint==='/git/ref/heads/main')return json({object:{sha:this.head}});
    if(endpoint.startsWith('/contents/')){
      const key=endpoint.slice(10),files=this.snapshots.get(url.searchParams.get('ref'))||this.files;
      if(method==='PUT'){const body=JSON.parse(options.body),prior=this.files.get(key);if(prior&&body.sha!==prior.sha)return json({},409);this.put(key,Buffer.from(body.content,'base64').toString('utf8'));return json({content:{sha:this.files.get(key).sha}});}
      if(key==='notes'||key==='documents')return json([...files].filter(([k])=>k.startsWith(key+'/')).map(([k,v])=>({path:k,name:k.split('/').pop(),sha:v.sha,type:'file',size:Buffer.byteLength(v.text)})));
      const f=files.get(key);return f?json({...f,content:Buffer.from(f.text).toString('base64'),encoding:'base64'}):json({},404);
    }
    if(endpoint.startsWith('/git/commits/')&&method==='GET')return json(this.commits.get(endpoint.split('/').pop()));
    if(endpoint==='/git/trees'){
      const body=JSON.parse(options.body);assert.ok(body.base_tree,'must preserve base tree');const files=new Map(this.trees.get(body.base_tree));
      for(const entry of body.tree){if(entry.sha===null){assert.ok(files.has(entry.path));files.delete(entry.path);}else{assert.equal(typeof entry.content,'string');files.set(entry.path,{text:entry.content,sha:hash(entry.content)});}}
      const sha='tree-'+(++this.seq);this.trees.set(sha,files);return json({sha},201);
    }
    if(endpoint==='/git/commits'&&method==='POST'){const body=JSON.parse(options.body),sha='commit-'+(++this.seq);this.commits.set(sha,{tree:{sha:body.tree},parents:body.parents});this.snapshots.set(sha,new Map(this.trees.get(body.tree)));return json({sha},201);}
    if(endpoint==='/git/refs/heads/main'&&method==='PATCH'){
      if(this.beforePatch){const action=this.beforePatch;this.beforePatch=null;await action();}
      const body=JSON.parse(options.body);assert.equal(body.force,false,'never force-update branch');const next=this.commits.get(body.sha);if(next.parents[0]!==this.head)return json({},422);this.head=body.sha;return json({object:{sha:this.head}});
    }
    throw new Error('Unexpected '+method+' '+endpoint);
  }
}
async function wait(predicate,label){for(let i=0;i<250;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw new Error('Timed out: '+label);}
async function app(repo,{drafts={},route='home'}={}){
  const errors=[],vc=new VirtualConsole();vc.on('jsdomError',error=>errors.push(error.message));
  const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{url:'https://532313.github.io/my-notes/#'+route,runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc}),w=dom.window;
  w.fetch=repo.fetch.bind(repo);w.TextEncoder=TextEncoder;w.TextDecoder=TextDecoder;w.matchMedia=()=>({matches:false,addEventListener(){}});w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};w.localStorage.setItem('notebook.drafts',JSON.stringify(drafts));
  for(const file of ['config.js','assets/vendor/marked.umd.js','assets/vendor/purify.min.js','guide/3568阅读资源/vendor/highlight.min.js','assets/github-store.js','assets/reading.js','assets/app.js'])w.eval(fs.readFileSync(path.join(root,file),'utf8'));
  const $=id=>w.document.getElementById(id);await wait(()=>$('cloudStatus').textContent==='已同步','initial sync');
  const connect=async()=>{$('tokenInput').value='fake-test-token';$('connectForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await wait(()=>$('connectButton').textContent==='已连接 GitHub'&&!$('connectSubmit').disabled,'connect');};
  return {w,$,errors,connect,close:()=>{assert.deepEqual(errors,[]);w.close();}};
}
async function run(){
  // Local drafts: cancellation, confirmation, no authorization or remote write, cleanup.
  {
    const repo=new Repo();repo.seed();const draft={...note('本机草稿'),sha:null},a=await app(repo,{route:'trash',drafts:{[draft.id]:draft}}),{w,$}=a;
    const remove=()=>w.document.querySelector('[data-permanent-delete="'+draft.id+'"]');assert.ok(remove());remove().click();assert.ok($('deleteDialog').open);assert.match($('deleteDialogText').textContent,/无法在网站中恢复/);assert.equal(w.document.activeElement.id,'cancelDeleteButton');$('cancelDeleteButton').click();assert.ok(remove());assert.equal(repo.calls.filter(c=>c.method!=='GET').length,0);checks.push('取消和默认焦点不会删除内容');
    w.localStorage.setItem('notebook.recent',JSON.stringify([draft.id]));w.localStorage.setItem('notebook.reading.'+draft.id,'{}');remove().click();$('confirmDeleteButton').click();await wait(()=>!remove(),'delete local draft');assert.equal(JSON.parse(w.localStorage.getItem('notebook.drafts'))[draft.id],undefined);assert.equal(w.localStorage.getItem('notebook.reading.'+draft.id),null);assert.equal(repo.calls.filter(c=>c.method!=='GET').length,0);assert.ok($('undoTrashButton').hidden);checks.push('本机草稿永久删除、记录清理且不写入云端');a.close();
  }
  // Authentication resumes at a fresh confirmation; cloud content stays until confirmed.
  {
    const repo=new Repo();repo.seed();const a=await app(repo,{route:'trash'}),{$,w}=a;
    w.document.querySelector('[data-permanent-delete="notes/回收笔记.md"]').click();assert.ok($('connectDialog').open);assert.ok(!$('deleteDialog').open);await a.connect();await wait(()=>$('deleteDialog').open,'confirm after auth');assert.ok(repo.files.has('notes/回收笔记.md'));$('cancelDeleteButton').click();assert.ok(repo.files.has('notes/回收笔记.md'));checks.push('重新连接后仍需确认，不自动永久删除');
    w.location.hash='#home';await wait(()=>$('viewTitle').textContent==='全部内容','home');assert.equal(w.document.querySelectorAll('[data-permanent-delete]').length,0);assert.ok($('batchPermanentDeleteButton').hidden);checks.push('永久删除入口仅出现在回收站');a.close();
  }
  // Mixed cloud/local/PDF batch: one atomic update, metadata pruning, other files retained.
  {
    const repo=new Repo();repo.seed();const draft={...note('本地待删'),sha:null},a=await app(repo,{route:'trash',drafts:{[draft.id]:draft}}),{$,w}=a;await a.connect();
    for(const id of ['notes/回收笔记.md','documents/过期资料.pdf',draft.id]){const box=w.document.querySelector('[data-select="'+id+'"]');box.checked=true;box.dispatchEvent(new w.Event('change',{bubbles:true}));}
    $('batchPermanentDeleteButton').click();assert.equal($('deleteDialogList').children.length,3);assert.ok($('confirmDeleteButton').classList.contains('danger'));$('confirmDeleteButton').click();$('confirmDeleteButton').click();await wait(()=>$('toastMessage').textContent==='已永久删除 3 份文档','batch deleted');
    assert.ok(!repo.files.has('notes/回收笔记.md'));assert.ok(!repo.files.has('documents/过期资料.pdf'));assert.ok(repo.files.has('notes/正常笔记.md'));assert.ok(repo.files.has('index.html'));assert.ok(repo.files.has('documents/保留资料.pdf'));
    const metadata=JSON.parse(repo.files.get('documents/.trash.json').text);assert.equal(metadata.files['documents/过期资料.pdf'],undefined);assert.ok(metadata.files['documents/保留资料.pdf']);assert.equal(repo.calls.filter(c=>c.method==='PATCH').length,1);assert.equal(Object.keys(JSON.parse(w.localStorage.getItem('notebook.drafts'))).length,0);assert.ok($('selectionBar').hidden);assert.ok($('undoTrashButton').hidden);checks.push('笔记、PDF 和本机草稿批量删除只提交一次；保留其余文件与回收站记录');
    const other=await app(repo,{route:'trash'});assert.equal(other.w.document.querySelector('[data-permanent-delete="notes/回收笔记.md"]'),null);assert.equal(other.w.document.querySelector('[data-permanent-delete="documents/过期资料.pdf"]'),null);other.close();checks.push('另一设备同步后不再显示已删除文件');a.close();
  }
  // Remote changes before confirmation, write failures, and simultaneous branch changes.
  for(const scenario of ['changed-note','restored-pdf','concurrent-restore','permission']){
    const repo=new Repo();repo.seed();const draft={...note('回收笔记'),sha:repo.files.get('notes/回收笔记.md').sha,body:'未发布的草稿'},a=await app(repo,{route:'trash',drafts:{[draft.id]:draft}}),{$,w}=a;await a.connect();
    const id=scenario.includes('pdf')||scenario==='concurrent-restore'?'documents/过期资料.pdf':draft.id;
    w.document.querySelector('[data-permanent-delete="'+id+'"]').click();
    if(scenario==='changed-note')repo.put(id,serialize({...note('回收笔记'),body:'另一设备的新内容'}));
    const restorePdf=()=>{const metadata=JSON.parse(repo.files.get('documents/.trash.json').text);delete metadata.files['documents/过期资料.pdf'];repo.put('documents/.trash.json',JSON.stringify(metadata));};
    if(scenario==='restored-pdf')restorePdf();if(scenario==='concurrent-restore')repo.beforePatch=restorePdf;if(scenario==='permission')repo.failStage='/git/trees';
    $('confirmDeleteButton').click();await wait(()=>$('listStatus').textContent.startsWith('永久删除未完成'),'failure '+scenario);assert.ok(repo.files.has(id));assert.ok(JSON.parse(w.localStorage.getItem('notebook.drafts'))[draft.id]);assert.ok(w.document.querySelector('[data-permanent-delete="'+id+'"]'));assert.equal($('batchPermanentDeleteButton').disabled,false);checks.push('失败保护：'+scenario+'，文件与草稿均保留');a.close();
  }
  // Restoring while the confirmation is open invalidates the pending operation.
  {
    const repo=new Repo();repo.seed();const a=await app(repo,{route:'trash'}),{$,w}=a;await a.connect();w.document.querySelector('[data-permanent-delete="notes/回收笔记.md"]').click();repo.put('notes/回收笔记.md',serialize(note('回收笔记',false)));$('refreshButton').click();await wait(()=>!w.document.querySelector('[data-permanent-delete="notes/回收笔记.md"]'),'refresh restore');$('confirmDeleteButton').click();await wait(()=>$('listStatus').textContent.startsWith('永久删除未完成'),'stale dialog');assert.ok(repo.files.has('notes/回收笔记.md'));checks.push('确认窗口中的旧选择不能删除已恢复文档');a.close();
  }
  // Search actions, existing soft-delete/restore, and permission/path boundaries.
  {
    const repo=new Repo();repo.seed();const a=await app(repo,{route:'trash'}),{$,w}=a;await a.connect();$('searchInput').value='回收笔记';$('searchInput').dispatchEvent(new w.Event('input'));await wait(()=>!$('searchResults').hidden,'search');assert.ok($('searchResults').querySelector('[data-permanent-delete]'));$('searchResults').querySelector('[data-permanent-delete]').click();assert.equal($('deleteDialogList').textContent,'回收笔记');$('cancelDeleteButton').click();checks.push('回收站搜索结果支持永久删除');
    $('searchInput').value='';$('searchInput').dispatchEvent(new w.Event('input'));await wait(()=>$('searchResults').hidden,'clear search');w.document.querySelector('[data-restore="notes/回收笔记.md"]').click();await wait(()=>!$('documentList').querySelector('[data-restore="notes/回收笔记.md"]'),'restore');assert.equal(JSON.parse(repo.files.get('notes/回收笔记.md').text.match(/^<!-- notebook: (.*) -->/)[1]).trashed,false);checks.push('现有恢复功能仍正常');
    const store=new w.NotebookGitHub.Store(w.NOTEBOOK_CONFIG,repo.fetch.bind(repo));await assert.rejects(store.deleteDocuments([note('无授权')]),e=>e.status===401);await store.connect('fake');await assert.rejects(store.deleteDocuments([{...note('正常笔记',false),sha:'x'}]),/只能永久删除/);await assert.rejects(store.deleteDocuments([{...note('非法'),path:'index.html',sha:'x'}]),/只能永久删除/);checks.push('缺少授权、正常文件及网站源码均不能永久删除');a.close();
  }
  console.log(JSON.stringify({passed:checks.length,checks,scope:'真实页面 DOM 与 GitHub API 模拟；未删除线上文件。'},null,2));
}
run().catch(error=>{console.error(error);process.exitCode=1;});
