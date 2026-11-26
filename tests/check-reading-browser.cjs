const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.NOTEBOOK_PLAYWRIGHT||'playwright');
const root=path.resolve(__dirname,'..'),origin='http://localhost:8787';
const docs=fs.readdirSync(path.join(root,'notes')).filter(file=>file.endsWith('.md')).map(file=>{
  const id='notes/'+file,raw=fs.readFileSync(path.join(root,id),'utf8'),header=raw.match(/^<!-- notebook: (.*?) -->\s*/);
  return {...JSON.parse(header[1]),id,path:id,type:'note',body:raw.slice(header[0].length)};
});
async function run(){
  const browser=await chromium.launch({channel:'chrome'});
  try{for(const width of [390,1440])for(const theme of ['light','dark']){
    const page=await browser.newPage({viewport:{width,height:844},colorScheme:theme});const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();const file=path.resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));return file.startsWith(root+path.sep)&&fs.existsSync(file)?route.fulfill({path:file}):route.abort();});
    await page.addInitScript(data=>{localStorage.setItem('notebook.cache',JSON.stringify(data));Object.defineProperty(navigator,'onLine',{value:false});},docs);
    await page.goto(origin);
    const belowSearch=page.locator('#libraryView > .search-field ~ :visible').first();
    assert.ok(await belowSearch.evaluate(node=>node.classList.contains('list-toolbar')));
    assert.equal(await page.locator('#continueNote').isVisible(),false);await page.locator('#searchInput').fill('platform_driver');const result=page.locator('#searchResults a').first();await result.click();await page.locator('#outlineToggle').click();
    const section=page.locator('#outlineList [data-jump]').nth(5),id=await section.getAttribute('data-jump');await section.click();
    await page.waitForFunction(id=>document.querySelector('[aria-current="location"]')?.dataset.jump===id,id);
    assert.equal(await page.locator('#outlinePanel').isVisible(),width===1440);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('dark')),theme==='dark');
    await page.locator('.back-to-library').evaluate(link=>link.click());await page.locator('#searchInput').waitFor();assert.equal(await page.locator('#searchInput').inputValue(),'platform_driver');await page.locator('#searchInput').fill('');await belowSearch.locator('#continueNote').click();await page.waitForFunction(id=>document.querySelector('[aria-current="location"]')?.dataset.jump===id,id);
    await page.goto(origin+'/#notebook/5710');
    const courseLink=page.locator('#course5710Feature');
    await courseLink.waitFor();assert.equal(await courseLink.getAttribute('href'),'5710/');
    await page.goto(origin+'/#home');await courseLink.waitFor({state:'hidden'});
    assert.deepEqual(errors,[]);await page.close();console.log(`${width}px ${theme}: search, outline, width, return and resume passed`);
  }}finally{await browser.close();}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
