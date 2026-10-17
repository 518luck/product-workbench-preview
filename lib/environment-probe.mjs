import { digest } from './analysis-facts.mjs';
import { BlueprintError } from './errors.mjs';

// Only this fixed program can supply a formal environment limitation. Arbitrary
// shell commands, hand-written output and process.exit(1) remain ordinary records.
const program = `
import fs from 'node:fs'; import path from 'node:path'; import net from 'node:net';
const spec=JSON.parse(process.argv.at(-1)); let available=false,reason='not-found';
if(spec.kind==='command'){
 const bases=spec.target.includes('/')||spec.target.includes('\\\\')?[path.resolve(spec.target)]:(process.env.PATH||'').split(path.delimiter).filter(Boolean).map(dir=>path.join(dir,spec.target));
 const extensions=process.platform==='win32'&&!path.extname(spec.target)?['',...(process.env.PATHEXT||'.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]:[''];
 const candidates=bases.flatMap(file=>extensions.map(ext=>file+ext));
 for(const file of candidates)try{if(fs.statSync(file).isFile()){fs.accessSync(file,fs.constants.X_OK);available=true;break;}}catch{}
}else if(spec.kind==='file'){
 try{fs.statSync(path.resolve(spec.target));available=true;}catch(error){reason=error.code;}
}else{
 await new Promise(resolve=>{const socket=net.createConnection({host:spec.host.replace(/^\\[|\\]$/g,''),port:spec.port});let done=false;const finish=(value,code)=>{if(done)return;done=true;available=value;reason=code;socket.destroy();resolve();};socket.setTimeout(1500);socket.once('connect',()=>finish(true,'connected'));socket.once('error',error=>finish(false,error.code));socket.once('timeout',()=>finish(false,'ETIMEDOUT'));});
}
if(available)reason='available';console.log(JSON.stringify({version:1,spec,available,reason}));process.exitCode=available?0:1;
`;
export function environmentCommand(spec) {
  const valid =
    spec &&
    typeof spec === 'object' &&
    !Array.isArray(spec) &&
    ['command', 'file', 'tcp'].includes(spec.kind) &&
    Object.keys(spec).every((key) =>
      (spec.kind === 'tcp' ? ['kind', 'host', 'port'] : ['kind', 'target']).includes(key),
    ) &&
    (spec.kind === 'tcp'
      ? typeof spec.host === 'string' &&
        /^[a-zA-Z0-9.:[\]_-]+$/.test(spec.host) &&
        Number.isInteger(spec.port) &&
        spec.port > 0 &&
        spec.port < 65536
      : typeof spec.target === 'string' &&
        Boolean(spec.target.trim()) &&
        !spec.target.includes('\0'));
  if (!valid)
    throw new BlueprintError(
      'INVALID_ARGUMENT',
      '环境诊断使用 kind:command|file 与 target，或 kind:tcp、host、port；不接受自定义脚本。',
    );
  return {
    command: process.execPath,
    args: ['--input-type=module', '-e', program, JSON.stringify(spec)],
    timeoutMs: 5000,
    purpose: 'environment',
  };
}
export const environmentProbeHash = () => digest(program);
export function trustedEnvironmentFailure(run) {
  try {
    const expected = environmentCommand(run.diagnostic.spec);
    return (
      run.purpose === 'environment' &&
      run.diagnostic.version === 1 &&
      run.diagnostic.probeHash === environmentProbeHash() &&
      run.command === expected.command &&
      JSON.stringify(run.args) === JSON.stringify(expected.args) &&
      run.diagnostic.available === false &&
      run.exitCode === 1 &&
      !run.signal &&
      !run.timedOut &&
      !run.outputExceeded &&
      run.sourceStable &&
      run.documentStable
    );
  } catch {
    return false;
  }
}
