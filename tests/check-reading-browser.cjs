const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.NOTEBOOK_PLAYWRIGHT||'playwright');
const root=path.resolve(__dirname,'..'),origin='http://localhost:8787';
const docs=fs.readdirSync(path.join(root,'notes')).filter(file=>file.endsWith('.md')).map(file=>{
  const id='notes/'+file,raw=fs.readFileSync(path.join(root,id),'utf8'),header=raw.match(/^<!-- notebook: (.*?) -->\s*/);
  return {...JSON.parse(header[1]),id,path:id,type:'note',body:raw.slice(header[0].length)};
});
async function checkGsyTrace(page,width){
  const phase=id=>'#note/notes%2Fgsytrace-'+id+'.md';
  const stages=Array.from({length:8},(_,n)=>phase('m'+n));
  const toggle=page.locator('#outlineToggle'),directory=page.locator('#outlinePanel');
  const index=page.locator('#outlineSeries a');
  const title=page.locator('#noteReadTitle');
  const body=page.locator('.markdown-body');
  const desktop=width>=1100;
  await page.goto(origin+'/'+phase('overview'));
  await title.getByText('GsyTrace 应用层总览',{exact:false}).waitFor();
  assert.equal(await directory.isVisible(),desktop);
  if(!desktop)await toggle.click();
  assert.deepEqual(await index.evaluateAll(a=>a.map(link=>link.getAttribute('href'))),[phase('overview'),...stages]);
  assert.equal(await page.locator('#outlineSeries a[aria-current="page"]').getAttribute('href'),phase('overview'));
  const openWidth=(await body.boundingBox()).width;
  assert.ok(openWidth>=(desktop?1020:350));
  await index.filter({hasText:'M3 ·'}).click();
  await title.getByText('GsyTrace M3',{exact:false}).waitFor();
  assert.equal(await directory.isVisible(),desktop);
  if(!desktop)await toggle.click();
  assert.equal(await page.locator('#outlineSeries a[aria-current="page"]').getAttribute('href'),phase('m3'));
  assert.equal(await index.count(),9);
  const chapter=page.locator('#outlineList [data-jump]').filter({hasText:'第二段'}).first();
  const section=await chapter.getAttribute('data-jump');
  await chapter.click();
  await page.waitForFunction(id=>document.querySelector('#outlineList [aria-current="location"]')?.dataset.jump===id,section);
  assert.equal(await directory.isVisible(),desktop);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(desktop){
    await toggle.click();
    assert.equal(await directory.isVisible(),false);
    const closedWidth=(await body.boundingBox()).width;
    assert.ok(closedWidth>=1100);
    await page.goto(origin+'/'+phase('m7'));
    await title.getByText('GsyTrace M7',{exact:false}).waitFor();
    assert.equal(await directory.isVisible(),false);
    await toggle.click();
    await page.locator('#outlineSeries a[aria-current="page"]').press('Escape');
    assert.equal(await directory.isVisible(),false);
    assert.equal(await toggle.evaluate(b=>document.activeElement===b),true);
  }
  await page.goto(origin+'/#note/'+encodeURIComponent('notes/Linux驱动面试重点与26篇优先级.md'));
  await page.locator('#outlineToggle').waitFor();
  assert.equal(await directory.isVisible(),false);
  await toggle.click();
  assert.equal(await page.locator('#outlineSeries').isVisible(),false);
  assert.ok(await page.locator('#outlineList [data-jump]').count()>0);
}

async function run(){
  const browser=await chromium.launch({channel:'chrome'});
  try{for(const width of [390,1440])for(const theme of ['light','dark']){
    const page=await browser.newPage({viewport:{width,height:844},colorScheme:theme});const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();const file=path.resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));return file.startsWith(root+path.sep)&&fs.existsSync(file)?route.fulfill({path:file}):route.abort();});
    await page.addInitScript(data=>{localStorage.setItem('notebook.cache',JSON.stringify(data));Object.defineProperty(navigator,'onLine',{value:false});},docs);
    await page.goto(origin);assert.equal(await page.locator('#continueNote').isVisible(),false);await page.locator('#searchInput').fill('platform_driver');const result=page.locator('#searchResults a').first();await result.click();await page.locator('#outlineToggle').click();
    const section=page.locator('#outlineList [data-jump]').nth(5),id=await section.getAttribute('data-jump');await section.click();
    await page.waitForFunction(id=>document.querySelector('[aria-current="location"]')?.dataset.jump===id,id);
    assert.equal(await page.locator('#outlinePanel').isVisible(),width===1440);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('dark')),theme==='dark');
    await page.locator('.back-to-library').evaluate(link=>link.click());await page.locator('#searchInput').waitFor();assert.equal(await page.locator('#searchInput').inputValue(),'platform_driver');await page.locator('#searchInput').fill('');await page.locator('#continueNote').click();await page.waitForFunction(id=>document.querySelector('[aria-current="location"]')?.dataset.jump===id,id);
    await checkGsyTrace(page,width);
    assert.deepEqual(errors,[]);await page.close();console.log(`${width}px ${theme}: search, outline, width, return, resume and GsyTrace navigation passed`);
  }}finally{await browser.close();}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
