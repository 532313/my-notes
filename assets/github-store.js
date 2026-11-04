(function(root){
  'use strict';
  const encodePath=path=>path.split('/').map(encodeURIComponent).join('/');
  class GitHubError extends Error{constructor(message,status){super(message);this.status=status;}}
  function parseNote(text,file){
    let meta={},body=text;const header=text.match(/^<!-- notebook: (.+) -->\r?\n(?:\r?\n)?/);
    if(header){try{meta=JSON.parse(header[1]);body=text.slice(header[0].length);}catch{}}
    const title=typeof meta.title==='string'?meta.title:body.match(/^#\s+(.+)$/m)?.[1]||file.name.replace(/\.md$/i,'');
    return {id:file.path,path:file.path,sha:file.sha,type:'note',title,notebook:typeof meta.notebook==='string'?meta.notebook:'学习笔记',body,
      created:meta.created||null,updated:meta.updated||null,favorite:meta.favorite===true,trashed:meta.trashed===true,source:meta.source&&typeof meta.source==='object'?meta.source:null};
  }
  function serializeNote(note){
    const meta={version:1,title:note.title.trim()||'未命名笔记',notebook:note.notebook.trim()||'学习笔记',created:note.created,updated:note.updated,favorite:!!note.favorite,trashed:!!note.trashed,source:note.source||null};
    return '<!-- notebook: '+JSON.stringify(meta).replace(/-->/g,'--\\u003e')+' -->\n\n'+note.body;
  }
  function base64(text){const bytes=new TextEncoder().encode(text);let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(binary);}
  class Store{
    constructor(config,transport=root.fetch.bind(root)){this.config=config;this.transport=transport;this.token='';this.cache=new Map();}
    async api(path,options={}){
      const response=await this.transport('https://api.github.com/repos/'+this.config.owner+'/'+this.config.repo+path,{...options,cache:'no-store',headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(this.token?{Authorization:'Bearer '+this.token}:{}),...(options.body?{'Content-Type':'application/json'}:{}),...options.headers}});
      if(!response.ok){let message=response.status===409||response.status===422?'云端内容已经变化，请保留草稿并另存副本。':response.status===401?'GitHub 授权已失效，请重新连接。':response.status===403?'GitHub 权限不足或请求次数已达上限，请检查授权后重试。':'GitHub 请求失败，请稍后重试。';throw new GitHubError(message,response.status);}
      return response.status===204?null:response.json();
    }
    async connect(token){
      this.token=token.trim();
      try{const repo=await this.api('');if(repo.permissions?.push===false)throw new GitHubError('此账号没有网站仓库的写入权限。',403);return repo.owner.login;}
      catch(error){this.token='';throw error;}
    }
    disconnect(){this.token='';}
    async directory(path,ref=this.config.branch){try{return await this.api('/contents/'+encodePath(path)+'?ref='+encodeURIComponent(ref));}catch(error){if(error.status===404)return [];throw error;}}
    async raw(file,ref=this.config.branch){
      if(this.cache.get(file.path)?.sha===file.sha)return this.cache.get(file.path).text;
      const url='https://raw.githubusercontent.com/'+this.config.owner+'/'+this.config.repo+'/'+encodeURIComponent(ref)+'/'+encodePath(file.path)+'?v='+encodeURIComponent(file.sha);
      const response=await this.transport(url,{cache:'no-store'});if(!response.ok)throw new GitHubError('笔记内容暂时无法载入，请重试。',response.status);
      const text=await response.text();this.cache.set(file.path,{sha:file.sha,text});return text;
    }
    async list(){
      const head=await this.api('/git/ref/heads/'+encodeURIComponent(this.config.branch)),ref=head.object.sha;
      if(this.lastHead===ref&&this.lastList)return this.lastList;
      const [notes,documents]=await Promise.all([this.directory('notes',ref),this.directory('documents',ref)]);
      const files=notes.filter(f=>f.type==='file'&&/\.md$/i.test(f.name));const result=[];let cursor=0;
      await Promise.all(Array.from({length:Math.min(4,files.length)},async()=>{while(cursor<files.length){const file=files[cursor++];result.push(parseNote(await this.raw(file,ref),file));}}));
      const trashFile=documents.find(f=>f.name==='.trash.json');let pdfTrash={};
      if(trashFile){const metadata=JSON.parse(await this.raw(trashFile,ref));if(metadata.version!==1||!metadata.files||typeof metadata.files!=='object'||Array.isArray(metadata.files))throw new Error('PDF 回收站记录无法读取，请检查后重试。');pdfTrash=metadata.files;}
      for(const file of documents.filter(f=>f.type==='file'&&/\.pdf$/i.test(f.name))){const state=pdfTrash[file.path];result.push({id:file.path,path:file.path,sha:file.sha,type:'pdf',title:file.name.replace(/^[a-f0-9-]{36}--/i,'').replace(/\.pdf$/i,''),notebook:'参考资料',size:file.size,trashed:state?.sha===file.sha&&state.trashed===true,updated:state?.sha===file.sha?state.updated:null});}
      this.lastHead=ref;this.lastList=result;return result;
    }
    async save(note){
      if(!this.token)throw new GitHubError('请先连接 GitHub，再保存到云端。',401);
      if(!/^notes\/[\w\u0080-\uffff .-]+\.md$/.test(note.path)||note.path.includes('..'))throw new Error('无效的笔记路径');
      const text=serializeNote(note);const payload={message:'更新笔记：'+note.title.slice(0,80),content:base64(text),branch:this.config.branch};if(note.sha)payload.sha=note.sha;
      const data=await this.api('/contents/'+encodePath(note.path),{method:'PUT',body:JSON.stringify(payload)});
      const saved={...note,sha:data.content.sha};this.cache.set(note.path,{sha:saved.sha,text});this.lastHead=null;this.lastList=null;return saved;
    }
    async setPdfTrashed(doc,trashed){
      if(!this.token)throw new GitHubError('请先连接 GitHub，再管理云端文档。',401);
      if(!/^documents\/[\w\u0080-\uffff .-]+\.pdf$/i.test(doc.path)||doc.path.includes('..'))throw new Error('无效的 PDF 路径');
      const current=await this.api('/contents/'+encodePath(doc.path)+'?ref='+encodeURIComponent(this.config.branch));
      if(current.sha!==doc.sha)throw new GitHubError('这份文档已在云端更新，请同步后重试。',409);
      let metadata={version:1,files:{}},sha;
      try{const file=await this.api('/contents/documents/.trash.json?ref='+encodeURIComponent(this.config.branch));sha=file.sha;
        if(file.encoding!=='base64'||typeof file.content!=='string')throw new Error('无法读取 PDF 回收站记录。');
        const binary=atob(file.content.replace(/\s/g,''));metadata=JSON.parse(new TextDecoder().decode(Uint8Array.from(binary,c=>c.charCodeAt(0))));
        if(metadata.version!==1||!metadata.files||typeof metadata.files!=='object'||Array.isArray(metadata.files))throw new Error('PDF 回收站记录格式有误，操作未执行。');
      }catch(error){if(error.status!==404)throw error;}
      const stamp=new Date().toISOString();
      if(trashed)metadata.files[doc.path]={sha:doc.sha,trashed:true,updated:stamp};else delete metadata.files[doc.path];
      const payload={message:(trashed?'移入回收站：':'恢复文档：')+doc.title,content:base64(JSON.stringify(metadata,null,2)+'\n'),branch:this.config.branch};if(sha)payload.sha=sha;
      await this.api('/contents/documents/.trash.json',{method:'PUT',body:JSON.stringify(payload)});
      this.cache.delete('documents/.trash.json');this.lastHead=null;this.lastList=null;
      return {...doc,trashed,updated:stamp};
    }
    async uploadPdf(file,id){
      if(!this.token)throw new GitHubError('请先连接 GitHub，再导入 PDF。',401);
      if(file.size>10*1024*1024)throw new Error('PDF 请控制在 10 MB 以内。');
      const bytes=new Uint8Array(await file.arrayBuffer());if(new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')throw new Error('文件内容不是有效的 PDF。');
      let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
      const name=id+'--'+file.name.replace(/[\/\\\u0000-\u001f]/g,'_');const path='documents/'+name;
      await this.api('/contents/'+encodePath(path),{method:'PUT',body:JSON.stringify({message:'添加资料：'+file.name,content:btoa(binary),branch:this.config.branch})});return path;
    }
    async pdfUrl(doc){
      const url='https://raw.githubusercontent.com/'+this.config.owner+'/'+this.config.repo+'/'+encodeURIComponent(this.config.branch)+'/'+encodePath(doc.path)+'?v='+encodeURIComponent(doc.sha);
      const response=await this.transport(url);if(!response.ok)throw new Error('PDF 暂时无法加载');return URL.createObjectURL(new Blob([await response.arrayBuffer()],{type:'application/pdf'}));
    }
  }
  root.NotebookGitHub={Store,GitHubError,parseNote,serializeNote,base64};
})(typeof window==='undefined'?globalThis:window);
