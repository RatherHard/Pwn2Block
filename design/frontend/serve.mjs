/* global console, process, URL */
import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {dirname,resolve,relative,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.md':'text/plain; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png'};
export function previewServer(port=4174){
  const server=createServer(async(req,res)=>{
    try{
      const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
      const target=resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
      const rel=relative(root,target);
      if(rel==='..'||rel.startsWith('..'+sep)||rel.includes(':')){res.writeHead(403).end();return;}
      if(!(await stat(target)).isFile()){res.writeHead(404).end();return;}
      res.writeHead(200,{'Content-Type':types[extname(target)]||'text/plain; charset=utf-8','Cache-Control':'no-store'});
      res.end(await readFile(target));
    }catch{res.writeHead(404).end('Not found');}
  });
  server.listen(port,'127.0.0.1',()=>console.log(`Pwn2Block design preview: http://127.0.0.1:${server.address().port}`));
  return server;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))previewServer(Number(process.argv[2]||4174));
