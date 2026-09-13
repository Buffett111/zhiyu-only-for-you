import { readFile,mkdir,readdir,writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
const origin=process.env.PUBLIC_ORIGIN||'https://zhiyu.example.invalid';
const url=new URL(origin);
if(url.origin!==origin||url.protocol!=='https:'||url.username||url.password)throw new Error('Extension requires an HTTPS PUBLIC_ORIGIN.');
const output='.cache/zhiyu-youtube-extension';
await mkdir(output,{recursive:true});await mkdir('public/downloads',{recursive:true});
const files:Record<string,Uint8Array>={};
for(const name of await readdir('extension')){
  if(!/^[a-z-]+\.(json|js|css|html)$/.test(name))throw new Error('Unexpected extension file');
  const bytes=Buffer.from((await readFile(`extension/${name}`,'utf8')).replaceAll('https://zhiyu.example.invalid',origin));
  files[`zhiyu-youtube-extension/${name}`]=bytes;await writeFile(`${output}/${name}`,bytes);
}
const notice=await readFile('THIRD_PARTY_NOTICES.md');files['zhiyu-youtube-extension/THIRD_PARTY_NOTICES.md']=notice;await writeFile(`${output}/THIRD_PARTY_NOTICES.md`,notice);
await writeFile('public/downloads/zhiyu-youtube-extension.zip',zipSync(files));
console.log('YouTube extension bundled; no credentials included.');
