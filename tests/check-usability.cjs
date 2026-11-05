// Run with NOTEBOOK_JSDOM set as in check-trash.cjs.
const assert=require('node:assert/strict');
const {Repo,app,note,serialize,wait}=require('./check-trash.cjs');
const checks=[],id='notes/正常笔记.md';
const write=(a,key,value)=>{a.$(key).value=value;a.$(key).dispatchEvent(new a.w.Event('input',{bubbles:true}));};
const writes=repo=>repo.calls.filter(c=>c.method!=='GET').length;
async function open(a,path=id){a.w.location.hash='#note/'+encodeURIComponent(path);await wait(()=>!a.$('noteView').hidden&&a.$('noteTitle').value,'open note');}
async function run(){
  {
    const repo=new Repo();repo.seed();const a=await app(repo);await open(a);const {$,w}=a;
    assert.equal($('noteTitle').readOnly,true);assert.equal($('noteNotebook').readOnly,true);assert.equal($('noteBody').readOnly,true);assert.equal(w.document.querySelector('button[data-mode=read]').getAttribute('aria-pressed'),'true');$('saveNoteButton').click();assert.equal(writes(repo),0);assert.ok(!$('connectDialog').open);assert.equal(Object.keys(JSON.parse(w.localStorage.getItem('notebook.drafts'))).length,0);checks.push('阅读模式只读，重复保存不会产生草稿或云端提交');
    w.document.querySelector('button[data-mode=edit]').click();assert.equal($('noteTitle').readOnly,false);write(a,'noteBody','本机未发布修改');await wait(()=>!$('discardDraftButton').hidden,'draft actions');w.document.querySelector('button[data-mode=read]').click();assert.equal($('noteTitle').readOnly,true);
    $('discardDraftButton').click();assert.match($('deleteDialogText').textContent,/GitHub 上的内容不会改变/);assert.equal(w.document.activeElement.id,'cancelDeleteButton');$('cancelDeleteButton').click();assert.equal($('noteBody').value,'本机未发布修改');assert.ok(JSON.parse(w.localStorage.getItem('notebook.drafts'))[id]);checks.push('取消放弃操作后，草稿与当前正文均保留');
    $('discardDraftButton').click();$('confirmDeleteButton').click();assert.match($('noteBody').value,/测试正文/);assert.equal($('editorLayout').dataset.mode,'read');assert.ok($('discardDraftButton').hidden);assert.equal(JSON.parse(w.localStorage.getItem('notebook.drafts'))[id],undefined);assert.equal(writes(repo),0);checks.push('放弃本机修改准确回到云端版本，不写入 GitHub');a.close();
  }
  {
    const repo=new Repo();repo.seed();const a=await app(repo);await open(a);const {$,w}=a;
    w.document.querySelector('button[data-mode=edit]').click();write(a,'noteBody','本机草稿');$('discardDraftButton').click();repo.put(id,serialize({...note('正常笔记',false),body:'其他设备发布的新正文'}));$('refreshButton').click();await wait(()=>$('conflictPanel').hidden===false,'cloud changed');$('confirmDeleteButton').click();assert.equal($('noteBody').value,'其他设备发布的新正文');assert.ok($('conflictPanel').hidden);assert.equal(writes(repo),0);checks.push('云端更新后放弃草稿，读取最近同步的新版本');a.close();
  }
  {
    const repo=new Repo();repo.seed();const a=await app(repo),{$,w}=a;$('newNoteButton').click();await wait(()=>!$('noteView').hidden,'new draft');write(a,'noteTitle','一次性的本机草稿');write(a,'noteBody','待确认内容');$('discardDraftButton').click();assert.equal($('headerContext').textContent,'一次性的本机草稿');assert.match($('deleteDialogTitle').textContent,/未发布草稿/);$('cancelDeleteButton').click();assert.equal($('noteTitle').value,'一次性的本机草稿');$('discardDraftButton').click();$('confirmDeleteButton').click();await wait(()=>w.location.hash==='#home','discard new note');assert.equal(Object.keys(JSON.parse(w.localStorage.getItem('notebook.drafts'))).length,0);assert.equal(writes(repo),0);checks.push('新草稿可取消或确认丢弃，全程无需 GitHub 授权');a.close();
  }
  {
    const repo=new Repo();repo.seed();const code='int main(void) {\n    const char *s = "<tag> & 中文";\n    return 0;\n}\n';repo.put(id,serialize({...note('正常笔记',false),body:'## 测试代码\n\n```c\n'+code+'```'}));const a=await app(repo);await open(a);const {$,w}=a,copied=[];Object.defineProperty(w.navigator,'clipboard',{configurable:true,value:{writeText:async text=>copied.push(text)}});
    const button=$('notePreview').querySelector('.copy-note-code');assert.ok(button);assert.ok($('notePreview').querySelector('.hljs-keyword'));button.click();await wait(()=>button.textContent==='已复制','copy');assert.equal(copied[0],code);checks.push('复制完整原始代码，保留中文、换行、缩进和特殊字符');
    write(a,'noteFind','复制代码');await wait(()=>$('findCount').textContent==='未找到匹配','ignore code toolbar');write(a,'noteFind','return');await wait(()=>$('findCount').textContent.includes('1'),'find code');assert.equal($('notePreview').querySelectorAll('mark').length,1);checks.push('本篇查找只统计正文，忽略复制按钮和语言标记');
    Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async()=>{throw new Error('blocked');}}});let fallback='';w.document.execCommand=command=>{assert.equal(command,'copy');fallback=w.document.activeElement.value;return true;};button.click();await wait(()=>fallback!=='','fallback copy');assert.equal(fallback,code);assert.equal(w.document.querySelector('.clipboard-fallback'),null);checks.push('剪贴板 API 不可用时可回退复制，且不残留临时输入框');a.close();
  }
  {
    const repo=new Repo();repo.seed();const body='[本站指南](https://532313.github.io/my-notes/#guide?anchor=%23ch062)\n\n[独立指南](guide/index.html#ch068)\n\n[本站笔记](https://532313.github.io/my-notes/index.html#note/notes%2F%E5%9B%9E%E6%94%B6%E7%AC%94%E8%AE%B0.md)\n\n[外部文档](https://docs.kernel.org/)';repo.put(id,serialize({...note('正常笔记',false),body}));const a=await app(repo);await open(a);const {$,w}=a,links=[...$('notePreview').querySelectorAll('a')];
    assert.equal(links[0].getAttribute('href'),'#guide?anchor=%23ch062');assert.equal(links[1].getAttribute('href'),'#guide?anchor=%23ch068');assert.equal(links[2].target,'');assert.equal(links[3].target,'_blank');assert.match(links[3].rel,/noopener/);links[0].click();await wait(()=>!$('guideView').hidden,'internal guide');assert.match($('guideFrame').getAttribute('src'),/#ch062$/);checks.push('本站笔记和指南链接留在当前标签页，外部链接仍单独打开');a.close();
  }
  {
    const repo=new Repo();repo.seed();const original=repo.fetch.bind(repo);let failing=false;repo.fetch=(url,options)=>failing&&url.includes('/git/ref/')?Promise.resolve(new Response('{}',{status:503})):original(url,options);
    const a=await app(repo),{$,w}=a;failing=true;$('refreshButton').click();await wait(()=>$('cloudStatus').dataset.state==='error','sync error');assert.ok($('listStatus').textContent);assert.ok($('documentList').textContent.includes('正常笔记'));failing=false;$('refreshButton').click();await wait(()=>$('cloudStatus').dataset.state==='ready','sync recovered');assert.equal($('listStatus').textContent,'');assert.match($('cloudStatus').title,/上次同步/);checks.push('同步失败仍可阅读缓存，恢复后清除旧错误并显示同步时间');
    const count=repo.calls.length;w.dispatchEvent(new w.Event('focus'));w.dispatchEvent(new w.Event('focus'));assert.equal(repo.calls.length,count);$('refreshButton').click();await wait(()=>!$('refreshButton').disabled,'manual sync');assert.ok(repo.calls.length>count);checks.push('短时间切回页面不重复请求，手动同步仍立即生效');
    await open(a);Object.defineProperty(w.navigator,'onLine',{configurable:true,value:false});w.dispatchEvent(new w.Event('offline'));assert.equal($('cloudStatus').textContent,'离线');const offlineCount=repo.calls.length;$('noteSync').click();assert.equal(repo.calls.length,offlineCount);w.document.querySelector('button[data-mode=edit]').click();write(a,'noteBody','离线编辑的草稿');await wait(()=>w.localStorage.getItem('notebook.drafts').includes('离线编辑的草稿'),'offline draft');Object.defineProperty(w.navigator,'onLine',{value:true});w.dispatchEvent(new w.Event('online'));await wait(()=>$('cloudStatus').dataset.state==='ready','online recovered');assert.equal($('noteBody').value,'离线编辑的草稿');assert.ok(w.localStorage.getItem('notebook.drafts').includes('离线编辑的草稿'));checks.push('离线显示明确状态，继续保存草稿，联网同步不覆盖草稿');
    w.matchMedia=query=>({matches:query.includes('max-width'),addEventListener(){}});$('menuButton').click();assert.ok($('sidebar').classList.contains('open'));w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.ok(!$('sidebar').classList.contains('open'));assert.equal(w.document.activeElement.id,'menuButton');checks.push('移动端侧栏可用 Escape 关闭并返回菜单焦点');a.close();
  }
  console.log(JSON.stringify({passed:checks.length,checks,scope:'真实 DOM 和模拟 GitHub；未修改线上笔记。'},null,2));
}
run().catch(error=>{console.error(error);process.exitCode=1;});
