/* Local language analysis + grammar highlighting. No runtime network requests. */
(function(root){
  'use strict';
  const hl=root.hljs;
  if(!hl)return;
  hl.registerLanguage('kconfig',()=>({name:'Kconfig',keywords:{keyword:'config menuconfig menu endmenu choice endchoice if endif source rsource osource comment mainmenu bool tristate string int hex prompt default def_bool def_tristate depends on select imply range optional visible modules option help',literal:'y m n'},contains:[hl.HASH_COMMENT_MODE,hl.QUOTE_STRING_MODE,hl.NUMBER_MODE,{scope:'symbol',begin:'\\b[A-Z_][A-Z_0-9]*\\b'},{scope:'string',begin:/^\s*(?:help|---help---)\s*$/,end:/^(?=\S)/,contains:[]}]}));
  const labels={c:'C',cpp:'C++',dts:'设备树 DTS',makefile:'Makefile',bash:'Shell',shell:'终端会话',kconfig:'Kconfig',ini:'配置文件',python:'Python',json:'JSON',plaintext:'纯文本'};
  function analyze(text,hint=''){
    const choose=(language,reason)=>({language,label:labels[language],reason});
    if(hint==='Makefile'||/^\s*(?:obj-[my$]|KDIR\s*[:?+]?=|CROSS_COMPILE\s*[:?+]?=|(?:all|clean|modules)\s*:)/m.test(text)||/\$\((?:KDIR|PWD|MAKE|shell)\b/.test(text))return choose('makefile','构建目标或 Make 变量');
    if(/^\s*(?:menuconfig|config)\s+[A-Za-z_][A-Za-z_0-9]*\b/m.test(text)||/^\s*(?:endmenu|endchoice|mainmenu)\b/m.test(text))return choose('kconfig','Kconfig 配置项或菜单');
    if(/\/(?:dts-v1|plugin)\/|#(?:address|size)-cells|^\s*[\w,#-]+\s*=\s*</m.test(text)||/^\s*(?:[\w-]+:\s*)?[\w-]+@[\da-f]+\s*\{/mi.test(text)||/^\s*&[\w]+\s*\{/m.test(text)||/^\s*(?:compatible|status|device_type|model|clock-names|pinctrl-names)\s*=\s*"/m.test(text))return choose('dts','设备树节点、属性或 phandle 引用');
    if(/^\s*#\s*(?:include|define|undef|ifdef|ifndef|endif|pragma)\b|\b(?:struct|typedef|enum)\s+\w+|\b(?:static|extern|const|unsigned)\s+\w+|\b(?:int|void|char|size_t|ssize_t|u32|uint32_t)\s+[*\w]/m.test(text))return choose('c','C 声明、类型或预处理指令');
    if(/^\s*(?:def\s+\w+\(|from\s+\w+\s+import|import\s+\w+)/m.test(text))return choose('python','Python 定义或导入');
    if(/^\s*(?:[\w.-]+@[\w.-]+[^\n]*[$#]|\$\s+|#\s+(?:sudo|make|insmod|ls|cd)\b)/m.test(text))return choose('shell','终端提示符');
    if(/^\s*(?:sudo|insmod|rmmod|modprobe|lsmod|dmesg|echo|cat|cd|chmod|mount|export|make|gcc|aarch64-[\w-]*gcc)\b/m.test(text))return choose('bash','Shell 命令');
    if(/^\s*(?:CONFIG_\w+\s*=|\[[\w .-]+\]\s*$)/m.test(text))return choose('ini','配置赋值或分节');
    const code=text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,' ');
    if(/\b(?:if|while|for|switch)\s*\(|\b(?:return|goto)\s+[^;\n]*;|^\s*[A-Za-z_]\w*\s*\([^;\n]*\)\s*;|\w+(?:->|\.)\w+\s*=/m.test(code)||/^\s*[\w.*>-]+\s*=\s*[^;\n]+;/m.test(code))return choose('c','C 控制流、调用或赋值片段');
    const result=hl.highlightAuto(text,['c','dts','makefile']);
    return result.language&&result.relevance>=5&&result.relevance-(result.secondBest?.relevance||0)>=2?choose(result.language,'受限语法匹配'):choose('plaintext','片段不足以可靠识别语言');
  }
  function highlight(box){
    const lines=[...box.querySelectorAll('.source-line')],original=lines.map(line=>line.textContent),text=original.join('\n');
    const label=box.querySelector('.code-bar>span');
    const analysis=analyze(text,/^Makefile\b/.test(label?.textContent||'')?'Makefile':'');
    box.dataset.language=analysis.language;
    if(label){label.textContent=analysis.label;label.title=analysis.reason;}
    if(analysis.language==='plaintext')return analysis;
    const html=hl.highlight(text,{language:analysis.language,ignoreIllegals:true}).value;
    const holder=document.createElement('template');holder.innerHTML=html;
    const fragments=lines.map(()=>document.createDocumentFragment());let row=0;
    function walk(node,scopes){
      if(node.nodeType===3){const pieces=node.textContent.split('\n');pieces.forEach((piece,i)=>{if(i)row++;if(!fragments[row])return;let child=document.createTextNode(piece);for(let n=scopes.length-1;n>=0;n--){const span=document.createElement('span');span.className=scopes[n];span.append(child);child=span;}fragments[row].append(child);});}
      else{const next=node.nodeType===1&&node.className?[...scopes,node.className]:scopes;node.childNodes.forEach(child=>walk(child,next));}
    }
    walk(holder.content,[]);
    // Preserve exact source text and the separate line-number column.
    if(fragments.length===row+1&&fragments.every((f,i)=>f.textContent===original[i]))lines.forEach((line,i)=>line.replaceChildren(fragments[i]));
    return analysis;
  }
  root.CodeSyntax={analyze,highlight,version:hl.versionString};
})(typeof window==='undefined'?globalThis:window);
