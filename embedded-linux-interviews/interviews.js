(() => {
  'use strict';
  const filter=document.getElementById('filters'), search=document.getElementById('search'), topic=document.getElementById('topic'), count=document.getElementById('count');
  const cards=[...document.querySelectorAll('#articles > article')];
  const nav=new Map([...document.querySelectorAll('#entries a')].map(link=>[link.getAttribute('href').slice(1),link]));
  for(const card of cards) if(![...topic.options].some(option=>option.value===card.dataset.topic)) topic.add(new Option(card.dataset.topic));
  const normalize=value=>value.normalize('NFKC').toLocaleLowerCase('zh-CN');
  const texts=cards.map(card=>normalize(card.textContent));
  function apply(){
    const words=normalize(search.value).trim().split(/\s+/).filter(Boolean);
    let matches=0;
    cards.forEach((card,i)=>{
      const visible=(!topic.value || card.dataset.topic===topic.value) && words.every(word=>texts[i].includes(word));
      card.hidden=!visible;
      if(nav.has(card.id)) nav.get(card.id).hidden=!visible;
      if(visible) matches++;
    });
    count.textContent=matches ? '显示 '+matches+' / '+cards.length+' 组面经' : '没有匹配结果，换个关键词或主题试试。';
  }
  function revealTarget(){
    const card=document.getElementById(location.hash.slice(1));
    if(card && cards.includes(card) && card.hidden){
      search.value='';topic.value='';apply();card.scrollIntoView();
    }
  }
  search.addEventListener('input',apply);topic.addEventListener('change',apply);window.addEventListener('hashchange',revealTarget);
  filter.hidden=false;apply();
})();