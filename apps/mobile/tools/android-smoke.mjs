import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const output='/artifacts';
const packageName='cn.anote.mobile.preview';
const mobileVersion=JSON.parse(fs.readFileSync(output+'/mobile-version.json','utf8')).version;
assert(/^\d+\.\d+\.\d+$/.test(mobileVersion),'Numeric mobile version');
const apkFile=output+'/ANote-'+mobileVersion+'-android-preview.apk';
const apkSHA256=createHash('sha256').update(fs.readFileSync(apkFile)).digest('hex');
const adbTimeout=Number(process.env.ANOTE_ADB_TIMEOUT_MS||25000);
assert(Number.isInteger(adbTimeout)&&adbTimeout>=25000&&adbTimeout<=90000,'ADB timeout must stay between 25 and 90 seconds');
const adb=(...args)=>execFileSync('/opt/android-sdk/platform-tools/adb',args,{encoding:'utf8',timeout:adbTimeout,maxBuffer:10*1024*1024});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const shellQuote=value=>"'"+String(value).replaceAll("'", "'\\''")+"'";
const secrets=[];
const redact=value=>secrets.reduce((text,secret)=>text.replaceAll(secret,'[redacted]'),value);
let lastHierarchy='';
function hierarchy() {
  adb('shell','uiautomator','dump','/sdcard/anote-smoke.xml');
  lastHierarchy=adb('exec-out','cat','/sdcard/anote-smoke.xml');
  return lastHierarchy;
}
function nodes(xml) {
  return [...xml.matchAll(/<node\s+([^>]+)>/g)].map(match=>Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(value=>[value[1],value[2]])));
}
function tap(node) {
  if(!node){
    fs.writeFileSync(output+'/android-smoke-failure.xml',redact(lastHierarchy));
    try{screenshot('android-smoke-failure.png');}catch{}
    try{fs.writeFileSync(output+'/android-smoke-failure-logcat.txt',redact(adb('logcat','-d','-t','200','-s','AndroidRuntime:E','chromium:E','ActivityManager:W')));}catch{}
  }
  assert(node,'Expected UI element is missing');
  const bounds=node.bounds?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  assert(bounds,'Expected UI element has no bounds');
  adb('shell','input','tap',String(Math.round((+bounds[1]+ +bounds[3])/2)),String(Math.round((+bounds[2]+ +bounds[4])/2)));
}
function byText(xml,value) {
  const matches=nodes(xml).filter(node=>node.text===value || node['content-desc']===value);
  return matches.find(node=>node.clickable==='true') || matches[0];
}
async function waitFor(test,label,timeout=45000) {
  const deadline=Date.now()+timeout;
  let xml='';
  while(Date.now()<deadline) {
    xml=hierarchy();
    if(test(xml))return xml;
    await delay(1500);
  }
  fs.writeFileSync(output+'/android-smoke-failure.xml',redact(xml));
  try{screenshot('android-smoke-failure.png');}catch{}
  throw new Error('Timed out: '+label);
}
function screenshot(name){fs.writeFileSync(output+'/'+name,execFileSync('/opt/android-sdk/platform-tools/adb',['exec-out','screencap','-p'],{maxBuffer:15*1024*1024,timeout:adbTimeout}));}

const deadline=Date.now()+180000;
while(Date.now()<deadline){try{if(adb('shell','getprop','sys.boot_completed').trim()==='1')break;}catch{}await delay(2000);}
assert.equal(adb('shell','getprop','sys.boot_completed').trim(),'1','Android boot');
const guestMemoryKiB=Number(/MemTotal:\s+(\d+)/.exec(adb('shell','cat','/proc/meminfo'))?.[1]||0);
if(process.env.ANOTE_EXPECT_GUEST_MAX_KIB){
  const maximum=Number(process.env.ANOTE_EXPECT_GUEST_MAX_KIB);
  assert(guestMemoryKiB>0&&guestMemoryKiB<=maximum,'Emulator must honor the requested low-RAM test configuration');
}
adb('shell','input','keyevent','82');
adb('shell','settings','put','secure','show_ime_with_hard_keyboard','1');
adb('shell','settings','put','secure','autofill_service','null');
let systemStableObserved=false;
if(process.env.ANOTE_WAIT_SYSTEM_STABLE==='1'){
  let stable=0;const until=Date.now()+120000;
  while(Date.now()<until&&stable<2){
    try{
      const packages=adb('shell','pm','list','packages','--user','0');
      const visible=hierarchy();
      stable=/^package:/m.test(packages)&&nodes(visible).length>2?stable+1:0;
    }catch{stable=0;}
    if(stable<2)await delay(1000);
  }
  assert(stable>=2,'Package manager and non-empty UI hierarchy must be stable before product checks');
  systemStableObserved=true;
}
let apkInstallation='installed';
try{
  const remote=/^package:(\S+\.apk)$/m.exec(adb('shell','pm','path',packageName));
  if(remote&&adb('shell','sha256sum '+shellQuote(remote[1])).trim().split(/\s+/)[0]===apkSHA256)apkInstallation='verified-existing';
}catch{/* No matching APK is installed yet. */}
if(apkInstallation==='installed')adb('install','-r',apkFile);
adb('shell','am','force-stop',packageName);
adb('shell','pm','clear',packageName);
adb('shell','am','start','-W','-n',packageName+'/cn.anote.mobile.MainActivity');
let xml=await waitFor(value=>!!byText(value,'连接服务器'),'server selector');
assert(xml.includes(mobileVersion),'Correct app version');
assert(!xml.includes('android.webkit.WebView'),'First launch must have no WebView/network page');
screenshot('android-01-server-selector.png');
fs.writeFileSync(output+'/android-01-server-selector.xml',xml);
tap(byText(xml,'连接服务器'));
xml=await waitFor(value=>(value.includes('用户名')&&value.includes('密码'))||value.includes('Casdoor'),'web login');
screenshot('android-02-login.png');
fs.writeFileSync(output+'/android-02-login.xml',xml);
const result={android:adb('shell','getprop','ro.build.version.release').trim(),api:adb('shell','getprop','ro.build.version.sdk').trim(),guestMemoryKiB,deviceLowRamProperty:adb('shell','getprop','ro.config.low_ram').trim(),systemStableObserved,adbTimeoutMs:adbTimeout,package:packageName,apkSHA256,apkInstallation,checks:['APK installed','Native selector shown before connection','No WebView created before user connection','Preview HTTP origin loaded','Web login rendered']};
const checkpoint=()=>fs.writeFileSync(output+'/android-smoke-progress.json',JSON.stringify({...result,status:'running',recordedAt:new Date().toISOString()},null,2)+'\n');
checkpoint();
if(process.argv.includes('--login')){
  const fixture=JSON.parse(fs.readFileSync('/tmp/anote-mobile-fixture.json','utf8'));
  secrets.push(fixture.password);
  assert(xml.includes(new URL(fixture.url).origin),'Fixture URL must match the connected preview before sending test credentials');
  const editables=nodes(xml).filter(node=>node.class==='android.widget.EditText');
  assert.equal(editables.length,2,'Username and password controls');
  tap(editables[0]);
  adb('shell','input text '+shellQuote(fixture.username));
  adb('shell','input','keyevent','KEYCODE_TAB');
  adb('shell','input text '+shellQuote(fixture.password));
  // Submit the real HTML form with a hardware Enter. IME visibility and slow
  // input-method binder diagnostics must not drive native Back navigation.
  adb('shell','input','keyevent','KEYCODE_ENTER');
  xml=await waitFor(value=>!value.includes('用户名')&&(value.includes('主页')||value.includes('首页')||value.includes('工作空间')),'authenticated mobile workspace');
  screenshot('android-03-workspace.png');
  fs.writeFileSync(output+'/android-03-workspace.xml',xml);
  result.checks.push('Isolated ordinary account logged in','Authenticated web workspace rendered');
  checkpoint();
  tap(byText(xml,'展开侧边栏'));
  xml=await waitFor(value=>!!byText(value,'关闭导航'),'mobile navigation drawer');
  screenshot('android-04-navigation.png');
  adb('shell','input','keyevent','4');
  xml=await waitFor(value=>!byText(value,'关闭导航')&&!!byText(value,'展开侧边栏'),'native back closes navigation');
  result.checks.push('Android back closes the web navigation drawer');
  checkpoint();
  tap(byText(xml,'展开侧边栏'));
  xml=await waitFor(value=>value.includes(fixture.notes[0].title),'fixture note in navigation');
  tap(byText(xml,fixture.notes[0].title));
  xml=await waitFor(value=>!!byText(value,'显示笔记列表')&&byText(value,'编辑')?.enabled==='true','note reading view ready for editing');
  screenshot('android-05-note-reading.png');
  fs.writeFileSync(output+'/android-05-note-reading.xml',xml);
  assert(!byText(xml,'关闭笔记列表'),'Same-library notes stay hidden while reading');
  tap(byText(xml,'显示笔记列表'));
  xml=await waitFor(value=>!!byText(value,'关闭笔记列表'),'same-library note drawer');
  adb('shell','input','keyevent','4');
  xml=await waitFor(value=>!byText(value,'关闭笔记列表')&&!!byText(value,'显示笔记列表'),'native back closes note drawer');
  result.checks.push('Fixture note opened in mobile reading mode','Same-library notes hidden by default','Android back closes same-library note drawer');
  checkpoint();
  tap(byText(xml,'编辑'));
  xml=await waitFor(value=>!!byText(value,'阅读')&&nodes(value).some(node=>node.class==='android.widget.EditText'),'explicit note edit mode');
  const area=node=>{const b=node.bounds?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);return b?(+b[3]- +b[1])*(+b[4]- +b[2]):0;};
  const editable=nodes(xml).filter(node=>node.class==='android.widget.EditText'&&node['content-desc']!=='笔记标题'&&node.text!==fixture.notes[0].title).sort((a,b)=>area(b)-area(a))[0];
  tap(editable);
  adb('shell','input','keycombination','KEYCODE_CTRL_LEFT','KEYCODE_MOVE_END');
  adb('shell','input','keyevent','KEYCODE_ENTER');
  const marker='ANoteNative050-'+Date.now();
  adb('shell','input text '+shellQuote(marker));
  screenshot('android-06-keyboard-edit.png');
  adb('shell','input','keycombination','KEYCODE_CTRL_LEFT','KEYCODE_S');
  // Success status hides after 2.2 seconds; capture it without the slower UI dump.
  await delay(200);
  screenshot('android-06b-save-confirmation.png');
  // Check server persistence, so a local WebView/IndexedDB cache cannot make this pass.
  const origin=new URL(fixture.url).origin;
  const versionResponse=await fetch(origin+'/api/version',{redirect:'error'});
  assert(versionResponse.ok,'Read the isolated preview web build identity');
  const version=await versionResponse.json();
  result.server={origin,webBuildId:version.build_id,editorSchema:version.editor_schema};
  const authResponse=await fetch(origin+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:fixture.username,password:fixture.password})});
  assert(authResponse.ok,'Isolated account API login for persistence verification');
  const auth=await authResponse.json();
  const deadline=Date.now()+60000;
  let persisted;
  while(Date.now()<deadline){
    const response=await fetch(origin+'/api/documents/'+fixture.notes[0].id,{headers:{Authorization:'Bearer '+auth.token}});
    assert(response.ok,'Read owned fixture note');
    const data=await response.json();
    assert.equal(data.title,fixture.notes[0].title,'Editing must change the body, not the title field');
    const texts=[];
    const visit=node=>{if(!node||typeof node!=='object')return;if(typeof node.text==='string')texts.push(node.text);if(Array.isArray(node.content))node.content.forEach(visit);};
    visit(data.snapshot);
    if(texts.join('\n').includes(marker)){
      // This endpoint searches PostgreSQL's stored snapshot, not the live Y.Doc.
      const search=await fetch(origin+'/api/documents?space_id='+fixture.library.id+'&q='+encodeURIComponent(marker),{headers:{Authorization:'Bearer '+auth.token}});
      assert(search.ok,'Search owned fixture library');
      if((await search.json()).some(note=>note.id===fixture.notes[0].id)){persisted=data;break;}
    }
    await delay(1200);
  }
  assert(persisted,'ADB-entered plain text must be persisted on the isolated server');
  xml=await waitFor(value=>!!byText(value,'阅读'),'saved note editing toolbar');
  tap(byText(xml,'阅读'));
  xml=await waitFor(value=>!!byText(value,'编辑'),'return to reading');
  tap(byText(xml,'返回知识库'));
  xml=await waitFor(value=>value.includes(fixture.notes[0].title)&&!byText(value,'显示笔记列表'),'library after saved note');
  tap(byText(xml,fixture.notes[0].title));
  xml=await waitFor(value=>!!byText(value,'显示笔记列表'),'reopened saved note');
  for(let scroll=0;scroll<7&&!xml.includes(marker);scroll++){
    adb('shell','input','swipe','540','2050','540','750','400');
    await delay(300);
    xml=hierarchy();
  }
  assert(xml.includes(marker),'Reopened note must visibly retain the saved plain text');
  screenshot('android-07-reopened-saved-note.png');
  fs.writeFileSync(output+'/android-07-reopened-saved-note.xml',redact(xml));
  fs.writeFileSync(output+'/android-edit-proof.json',JSON.stringify({noteId:fixture.notes[0].id,marker,manualSaveRequested:true,serverPersistenceConfirmed:true,snapshotSHA256:createHash('sha256').update(JSON.stringify(persisted.snapshot)).digest('hex')},null,2)+'\n');
  result.checks.push('Explicit edit mode and ADB plain text input','Ctrl+S invoked save','Plain text verified in the server snapshot','Saved note reopened with the same text');
  checkpoint();
  // Exercise Android's real print flow; the platform title must not become
  // the suggested PDF filename for a note. Cancel at the system save picker.
  tap(byText(xml,'客户端菜单'));
  xml=await waitFor(value=>!!byText(value,'打印 / 保存 PDF'),'native print action');
  tap(byText(xml,'打印 / 保存 PDF'));
  const printButton=value=>nodes(value).find(node=>node['resource-id']==='com.android.printspooler:id/print_button'&&node.enabled==='true');
  xml=await waitFor(value=>!!printButton(value),'Android PDF print preview',60000);
  screenshot('android-08-print-preview.png');
  tap(printButton(xml));
  const filenameInput=value=>nodes(value).find(node=>node.class==='android.widget.EditText'&&(/:id\/title$|:id\/file_name$/.test(node['resource-id']||'')||node.text?.endsWith('.pdf')));
  xml=await waitFor(value=>!!filenameInput(value),'Android PDF filename picker');
  const filename=filenameInput(xml).text,expectedFilename=fixture.notes[0].title+'.pdf';
  assert.equal(filename,expectedFilename,'Native PDF filename follows the note title');
  screenshot('android-09-pdf-filename.png');
  const printProof={noteId:fixture.notes[0].id,noteTitle:fixture.notes[0].title,defaultFilename:filename,expectedFilename,usesNoteTitle:true,systemSavePicker:true,savedFile:false};
  fs.writeFileSync(output+'/android-print-title-proof.json',JSON.stringify(printProof,null,2)+'\n');
  result.print=printProof;
  for(let back=0;back<4;back++){
    adb('shell','input','keyevent','4');
    await delay(400);
    xml=hierarchy();
    if(byText(xml,'客户端菜单'))break;
  }
  assert(byText(xml,'客户端菜单'),'Return from the cancelled system PDF picker');
  result.checks.push('Native Android print preview rendered','System PDF save picker defaults to the current note title');
  checkpoint();
}
adb('shell','am','force-stop',packageName);
const crashes=adb('logcat','-d','-s','AndroidRuntime:E');
assert(!crashes.includes('FATAL EXCEPTION'),'No native crash');
result.completedAt=new Date().toISOString();
result.status='passed';
result.runtimeValidated=true;
fs.writeFileSync(output+'/android-smoke-result.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
