// ============ INFO TV APP - dashboard ============
const API = '';
let token = localStorage.getItem('infotv_token') || null;
let me = null;
let mode = 'login';
let currentTab = 'content';

// ---- tiny helpers ----
const $ = s => document.querySelector(s);
const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
function toast(msg){ const t = el('div','toast',msg); document.body.appendChild(t); setTimeout(()=>t.remove(),2200); }
function esc(s){ return (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function ago(iso){ if(!iso) return ''; const s=(Date.now()-new Date(iso+'Z').getTime())/1000;
  if(s<60)return 'just now'; if(s<3600)return Math.floor(s/60)+' min ago';
  if(s<86400)return Math.floor(s/3600)+' hr ago'; return Math.floor(s/86400)+' days ago'; }

async function api(path, opts={}){
  opts.headers = Object.assign({}, opts.headers, token ? {Authorization:'Bearer '+token} : {});
  if(opts.json){ opts.headers['Content-Type']='application/json'; opts.body=JSON.stringify(opts.json); delete opts.json; }
  if(!opts.method && opts.body){ opts.method='POST'; }
  const r = await fetch(API+path, opts);
  const data = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

// ============ AUTH ============
function toggleAuth(e){ e && e.preventDefault(); mode = mode==='login'?'register':'login';
  $('#authTitle').textContent = mode==='login'?'Login to your account':'Create your free account';
  $('#authBtn').textContent = mode==='login'?'Login':'Create account';
  $('#nameField').classList.toggle('hidden', mode!=='register');
  $('#switchText').textContent = mode==='login'?'New here?':'Already have an account?';
  $('#switchLink').textContent = mode==='login'?'Create a free account':'Login instead';
  $('#authErr').classList.add('hidden');
}
async function doAuth(){
  const email=$('#email').value.trim(), password=$('#password').value;
  const errBox=$('#authErr');
  try{
    const path = mode==='login'?'/api/auth/login':'/api/auth/register';
    const body = mode==='login'?{email,password}:{email,password,name:$('#regName').value.trim()};
    const res = await api(path,{json:body});
    if(res.pending){
      errBox.textContent = res.message || 'Account created. Awaiting admin approval.';
      errBox.classList.remove('hidden'); errBox.style.background='#ecfdf5'; errBox.style.color='#047857'; errBox.style.borderColor='#a7f3d0';
      toggleAuth({preventDefault(){}}); // flip back to login view
      return;
    }
    token=res.token; localStorage.setItem('infotv_token',token); me=res.user;
    enterApp();
  }catch(err){ errBox.textContent=err.message; errBox.classList.remove('hidden'); errBox.style.background=''; errBox.style.color=''; errBox.style.borderColor=''; }
}
function logout(){ localStorage.removeItem('infotv_token'); token=null; me=null;
  try{ $('#email').value=''; $('#password').value=''; if($('#regName'))$('#regName').value=''; }catch(e){}
  $('#app').classList.add('hidden'); $('#auth').classList.remove('hidden'); }

function enterApp(){
  $('#auth').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#userName').textContent = me.name || me.email;
  $('#userAvatar').textContent = (me.name||me.email||'U')[0].toUpperCase();
  $('#adminTab').classList.toggle('hidden', me.role!=='admin');
  switchTab('content');
}

// ============ NAV ============
document.querySelectorAll('.nav a').forEach(a=>a.addEventListener('click',e=>{
  e.preventDefault(); switchTab(a.dataset.tab);
}));
function switchTab(tab){
  currentTab=tab;
  document.querySelectorAll('.nav a').forEach(a=>a.classList.toggle('active',a.dataset.tab===tab));
  ({content:renderContent,screens:renderScreens,groups:renderGroups,websites:renderWebsites,admin:renderAdmin}[tab])();
}

// ============ CONTENT ============
async function renderContent(){
  const v=$('#view');
  v.innerHTML=`<div class="page-head"><h1>Content library</h1><div class="spacer"></div>
    <div class="toolbar"><button class="btn sm" onclick="pickFiles()">Upload files</button></div></div>
    <div id="contentGrid" class="grid"></div>`;
  const items = await api('/api/content');
  const g=$('#contentGrid');
  if(!items.length){ g.outerHTML=`<div class="empty"><h3>No content yet</h3><p>Upload images or videos to show on your screens.</p><br>
    <button class="btn sm" style="margin:0 auto" onclick="pickFiles()">Upload files</button></div>`; return; }
  g.innerHTML=items.map(c=>cardHTML(c)).join('');
}
function cardHTML(c){
  const src=`/uploads/${c.filename}`;
  const media = c.type==='video'
    ? `<video src="${src}#t=0.1" muted preload="metadata"></video><span class="badge">▶ video</span>`
    : `<img src="${src}" loading="lazy">`;
  return `<div class="card">
    <div class="thumb">${media}</div>
    <div class="card-body">
      <p class="title">${esc(c.title)}</p>
      <div class="meta">${c.type} • ${c.orientation||'landscape'} • ${ago(c.created_at)}</div>
    </div>
    <div class="card-actions"><span class="pill grey">${(c.size/1e6).toFixed(1)} MB</span>
      <span><button class="kebab" onclick="editContent(${c.id},'${esc(c.title).replace(/'/g,"\\'")}',${c.duration||10})" title="Edit">✏️</button>
      <button class="kebab" onclick="delContent(${c.id})" title="Delete">🗑</button></span></div>
  </div>`;
}
function editContent(id,title,duration){
  openModal('Edit content', `
    <div class="field"><label>Title</label><input id="ecTitle" value="${esc(title)}"></div>
    <div class="field"><label>Seconds to show — video: 0 = play full video, or set seconds to loop. Image: display time</label><input id="ecDur" type="number" min="0" value="${duration}"></div>`,
    [{label:'Save',cls:'btn',fn:async()=>{ try{
      await api('/api/content/'+id,{method:'PATCH',json:{title:$('#ecTitle').value.trim(),duration:+$('#ecDur').value||10}});
      closeModal(); toast('Content updated'); renderContent(); }catch(e){ toast(e.message);} }}]);
}
function pickFiles(){ $('#fileInput').click(); }
$('#fileInput').addEventListener('change', async e=>{
  const files=[...e.target.files]; e.target.value='';
  for(const f of files){
    const fd=new FormData(); fd.append('file',f); fd.append('title',f.name);
    fd.append('orientation', 'landscape');
    try{ await api('/api/content',{method:'POST',body:fd}); }catch(err){ toast(err.message); }
  }
  toast(`${files.length} file(s) uploaded`); renderContent();
});
async function delContent(id){ if(!confirm('Delete this content?'))return;
  await api('/api/content/'+id,{method:'DELETE'}); renderContent(); }

// ============ SCREENS ============
async function renderScreens(){
  const v=$('#view');
  v.innerHTML=`<div class="page-head"><h1>Screens</h1><div class="spacer"></div>
    <div class="toolbar"><button class="btn sm" onclick="pairModal()">Pair a screen</button></div></div>
    <div id="screenGrid" class="grid"></div>`;
  const [screens,groups]=await Promise.all([api('/api/screens'),api('/api/groups')]);
  window._groups=groups;
  const g=$('#screenGrid');
  if(!screens.length){ g.outerHTML=`<div class="empty"><h3>No screens paired</h3>
    <p>Open INFO TV APP on your TV, then enter the code it shows here.</p><br>
    <button class="btn sm" style="margin:0 auto" onclick="pairModal()">Pair a screen</button></div>`; return; }
  g.innerHTML=screens.map(s=>{
    const gname=(groups.find(x=>x.id===s.group_id)||{}).name;
    const online = s.last_seen && (Date.now()-new Date(s.last_seen+'Z'))<120000;
    return `<div class="card"><div class="thumb"><div class="icon-stack">🖥️</div>
      <span class="badge">${s.paused?'⏸ stopped':(online?'🟢 online':'⚪ offline')}</span></div>
      <div class="card-body"><p class="title">${esc(s.name||'Screen')}</p>
        <div class="meta">${gname?('Group: '+esc(gname)):'No group'} • seen ${ago(s.last_seen)||'never'}</div></div>
      <div class="card-actions">
        <span><button class="btn sm ghost" onclick="previewScreen(${s.id},'${esc(s.name).replace(/'/g,"\\'")}')">Preview</button>
        <button class="btn sm ghost" onclick="assignModal('screen',${s.id},'${esc(s.name)}')">Assign</button></span>
        <span><button class="kebab" onclick="editScreen(${s.id})" title="Rename / group">✏️</button>
        <button class="kebab" onclick="delScreen(${s.id})" title="Remove">🗑</button></span></div></div>`;
  }).join('');
}
function pairModal(){
  const opts=(window._groups||[]).map(g=>`<option value="${g.id}">${esc(g.name)}</option>`).join('');
  openModal('Pair a screen', `
    <p style="color:var(--muted);margin-top:0">On your TV, open <b>INFO TV APP</b>. It will show a 6-character code. Enter it below.</p>
    <div class="field"><label>Pairing code</label><input id="pairCode" placeholder="e.g. 4F9A2C" style="text-transform:uppercase"></div>
    <div class="field"><label>Screen name</label><input id="pairName" placeholder="Lobby TV"></div>
    <div class="field"><label>Group (optional)</label><select id="pairGroup" style="width:100%;padding:12px;border:1px solid var(--line);border-radius:10px"><option value="">— none —</option>${opts}</select></div>`,
    [{label:'Pair screen',cls:'btn',fn:async()=>{
      try{ await api('/api/screens/pair',{json:{code:$('#pairCode').value.trim(),name:$('#pairName').value.trim(),group_id:$('#pairGroup').value||null}});
        closeModal(); toast('Screen paired'); renderScreens();
      }catch(e){ toast(e.message); } }}]);
}
async function delScreen(id){ if(!confirm('Remove this screen?'))return;
  await api('/api/screens/'+id,{method:'DELETE'}); renderScreens(); }
async function editScreen(id){
  const [screens,groups]=await Promise.all([api('/api/screens'),api('/api/groups')]);
  const s=screens.find(x=>x.id===id); if(!s)return;
  const opts='<option value="">— none —</option>'+groups.map(g=>`<option value="${g.id}" ${g.id===s.group_id?'selected':''}>${esc(g.name)}</option>`).join('');
  openModal('Edit screen', `
    <div class="field"><label>Screen name</label><input id="eScrName" value="${esc(s.name||'')}"></div>
    <div class="field"><label>Group</label><select id="eScrGroup" style="width:100%;padding:12px;border:1px solid var(--line);border-radius:10px">${opts}</select></div>`,
    [{label:'Save',cls:'btn',fn:async()=>{ try{
      await api('/api/screens/'+id,{method:'PATCH',json:{name:$('#eScrName').value.trim(),group_id:$('#eScrGroup').value||null}});
      closeModal(); toast('Screen updated'); renderScreens(); }catch(e){ toast(e.message);} }}]);
}

// ============ GROUPS ============
async function renderGroups(){
  const v=$('#view');
  v.innerHTML=`<div class="page-head"><h1>Screen groups</h1><div class="spacer"></div>
    <div class="toolbar"><button class="btn sm" onclick="groupModal()">Add screen group</button></div></div>
    <div id="groupGrid" class="grid"></div>`;
  const groups=await api('/api/groups');
  const g=$('#groupGrid');
  if(!groups.length){ g.outerHTML=`<div class="empty"><h3>No groups yet</h3>
    <p>Groups let you push the same content to several screens at once.</p><br>
    <button class="btn sm" style="margin:0 auto" onclick="groupModal()">Add screen group</button></div>`; return; }
  g.innerHTML=groups.map(gr=>`<div class="card"><div class="thumb"><div class="icon-stack">🗂️</div></div>
    <div class="card-body"><p class="title">${esc(gr.name)}</p><div class="meta">${gr.screen_count} screen(s)</div></div>
    <div class="card-actions"><button class="btn sm ghost" onclick="assignModal('group',${gr.id},'${esc(gr.name)}')">Assign content</button>
      <span><button class="kebab" onclick="editGroup(${gr.id},'${esc(gr.name).replace(/'/g,"\\'")}')" title="Rename">✏️</button>
      <button class="kebab" onclick="delGroup(${gr.id})" title="Delete">🗑</button></span></div></div>`).join('');
}
function editGroup(id,name){
  openModal('Rename group', `<div class="field"><label>Group name</label><input id="egName" value="${esc(name)}"></div>`,
    [{label:'Save',cls:'btn',fn:async()=>{ try{
      await api('/api/groups/'+id,{method:'PATCH',json:{name:$('#egName').value.trim()}});
      closeModal(); toast('Group updated'); renderGroups(); }catch(e){ toast(e.message);} }}]);
}
function groupModal(){
  openModal('Add screen group', `<div class="field"><label>Group name</label><input id="grpName" placeholder="Store front"></div>`,
    [{label:'Create group',cls:'btn',fn:async()=>{ try{ await api('/api/groups',{json:{name:$('#grpName').value.trim()}});
      closeModal(); renderGroups(); }catch(e){ toast(e.message);} }}]);
}
async function delGroup(id){ if(!confirm('Delete this group?'))return;
  await api('/api/groups/'+id,{method:'DELETE'}); renderGroups(); }

// ============ WEBSITES ============
async function renderWebsites(){
  const v=$('#view');
  v.innerHTML=`<div class="page-head"><h1>Websites</h1><div class="spacer"></div>
    <div class="toolbar"><button class="btn sm" onclick="siteModal()">Add website</button></div></div>
    <div id="siteGrid" class="grid"></div>`;
  const sites=await api('/api/websites');
  const g=$('#siteGrid');
  if(!sites.length){ g.outerHTML=`<div class="empty"><h3>No websites yet</h3>
    <p>Display any web page — dashboards, menus, live pages — on your screens.</p><br>
    <button class="btn sm" style="margin:0 auto" onclick="siteModal()">Add website</button></div>`; return; }
  g.innerHTML=sites.map(s=>`<div class="card"><div class="thumb"><div class="icon-stack">🌐</div>
      <span class="badge">${s.duration}s</span></div>
    <div class="card-body"><p class="title">${esc(s.title)}</p><div class="meta" style="word-break:break-all">${esc(s.url)}</div></div>
    <div class="card-actions"><span class="pill">website</span>
      <span><button class="kebab" onclick="editSite(${s.id})" title="Edit">✏️</button>
      <button class="kebab" onclick="delSite(${s.id})" title="Delete">🗑</button></span></div></div>`).join('');
}
async function editSite(id){
  const sites=await api('/api/websites'); const s=sites.find(x=>x.id===id); if(!s)return;
  openModal('Edit website', `
    <div class="field"><label>Title</label><input id="esTitle" value="${esc(s.title)}"></div>
    <div class="field"><label>URL (YouTube links auto-convert)</label><input id="esUrl" value="${esc(s.url)}"></div>
    <div class="field"><label>Show for seconds (0 = play full / loop)</label><input id="esDur" type="number" min="0" value="${s.duration||0}"></div>`,
    [{label:'Save',cls:'btn',fn:async()=>{ try{
      await api('/api/websites/'+id,{method:'PATCH',json:{title:$('#esTitle').value.trim(),url:$('#esUrl').value.trim(),duration:+$('#esDur').value||0}});
      closeModal(); toast('Website updated'); renderWebsites(); }catch(e){ toast(e.message);} }}]);
}
function siteModal(){
  openModal('Add website', `
    <div class="field"><label>Title</label><input id="siteTitle" placeholder="Company dashboard"></div>
    <div class="field"><label>URL</label><input id="siteUrl" placeholder="https://example.com"></div>
    <div class="field"><label>Show for seconds (leave 0 = play full / loop; set seconds only to rotate)</label><input id="siteDur" type="number" min="0" value="0"></div>`,
    [{label:'Add website',cls:'btn',fn:async()=>{ try{
      await api('/api/websites',{json:{title:$('#siteTitle').value.trim(),url:$('#siteUrl').value.trim(),duration:+$('#siteDur').value||0}});
      closeModal(); renderWebsites(); }catch(e){ toast(e.message);} }}]);
}
async function delSite(id){ if(!confirm('Delete this website?'))return;
  await api('/api/websites/'+id,{method:'DELETE'}); renderWebsites(); }

// ============ ASSIGN PLAYLIST ============
async function assignModal(targetType,targetId,name){
  const [content,websites,current]=await Promise.all([
    api('/api/content'),api('/api/websites'),api(`/api/playlist/${targetType}/${targetId}`)]);
  const chosen=new Set(current.map(i=>i.item_type+':'+i.item_id));
  const row=(item_type,item_id,thumb,label,sub)=>`
    <label class="chk-row">
      <input type="checkbox" data-type="${item_type}" data-id="${item_id}" ${chosen.has(item_type+':'+item_id)?'checked':''}>
      ${thumb}<div><div style="font-weight:600;font-size:13px">${esc(label)}</div>
      <div style="color:var(--muted);font-size:12px">${sub}</div></div></label>`;
  let html='';
  if(content.length){ html+='<div style="font-size:12px;color:var(--muted);margin:0 0 6px;font-weight:600">CONTENT</div><div class="chk-list">';
    html+=content.map(c=>row('content',c.id,
      c.type==='video'?`<div class="mini" style="display:grid;place-items:center;color:#fff">▶</div>`:`<img class="mini" src="/uploads/${c.filename}">`,
      c.title, c.type)).join(''); html+='</div>'; }
  if(websites.length){ html+='<div style="font-size:12px;color:var(--muted);margin:14px 0 6px;font-weight:600">WEBSITES</div><div class="chk-list">';
    html+=websites.map(w=>row('website',w.id,`<div class="mini" style="display:grid;place-items:center;color:#fff">🌐</div>`,w.title,w.url)).join(''); html+='</div>'; }
  if(!content.length && !websites.length) html='<p style="color:var(--muted)">Upload content or add a website first.</p>';
  openModal('Assign to '+name, html, [{label:'Save playlist',cls:'btn',fn:async()=>{
    const items=[...document.querySelectorAll('.chk-row input:checked')].map(i=>({item_type:i.dataset.type,item_id:+i.dataset.id}));
    await api(`/api/playlist/${targetType}/${targetId}`,{method:'PUT',json:{items}});
    closeModal(); toast(`Playlist saved (${items.length} item(s))`);
  }}]);
}

// ============ ADMIN (users) ============
async function renderAdmin(){
  const v=$('#view');
  v.innerHTML=`<div class="page-head"><h1>Admin — Users</h1><div class="spacer"></div>
    <div class="toolbar"><button class="btn sm" onclick="addUserModal()">Add user</button></div></div>
    <div id="userList"></div>`;
  let users;
  try{ users=await api('/api/admin/users'); }
  catch(e){ $('#userList').innerHTML='<div class="empty"><h3>Admins only</h3><p>'+esc(e.message)+'</p></div>'; return; }
  const pending=users.filter(u=>!u.approved);
  const active=users.filter(u=>u.approved);
  const row=u=>`<div class="chk-row" style="justify-content:space-between">
    <div><div style="font-weight:600">${esc(u.name||u.email)} ${u.role==='admin'?'<span class="pill">admin</span>':''} ${u.approved?'<span class="pill green">approved</span>':'<span class="pill grey">pending</span>'}</div>
      <div style="color:var(--muted);font-size:12px">${esc(u.email)} • joined ${ago(u.created_at)}</div></div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      ${u.approved?`<button class="btn sm ghost" onclick="setApprove(${u.id},0)">Suspend</button>`
                  :`<button class="btn sm" onclick="setApprove(${u.id},1)">Approve</button>`}
      <button class="btn sm ghost" onclick="resetPwModal(${u.id},'${esc(u.email)}')">Password</button>
      ${u.id!==me.id?`<button class="kebab" onclick="delUser(${u.id})" title="Delete">🗑</button>`:''}
    </div></div>`;
  let html='';
  if(pending.length){ html+=`<h3 style="margin:10px 0">Pending approval (${pending.length})</h3><div class="chk-list">${pending.map(row).join('')}</div>`; }
  html+=`<h3 style="margin:18px 0 10px">All users (${active.length})</h3><div class="chk-list">${active.map(row).join('')}</div>`;
  $('#userList').innerHTML=html;
}
async function setApprove(id,val){ try{ await api('/api/admin/users/'+id,{method:'PATCH',json:{approved:val}}); toast(val?'User approved':'User suspended'); renderAdmin(); }catch(e){ toast(e.message);} }
async function delUser(id){ if(!confirm('Delete this user permanently?'))return; try{ await api('/api/admin/users/'+id,{method:'DELETE'}); renderAdmin(); }catch(e){ toast(e.message);} }
function addUserModal(){
  openModal('Add user', `
    <div class="field"><label>Name</label><input id="auName"></div>
    <div class="field"><label>Email</label><input id="auEmail" type="email"></div>
    <div class="field"><label>Password</label><input id="auPw" type="text"></div>
    <div class="field"><label>Role</label><select id="auRole" style="width:100%;padding:12px;border:1px solid var(--line);border-radius:10px"><option value="user">User</option><option value="admin">Admin</option></select></div>`,
    [{label:'Create user',cls:'btn',fn:async()=>{ try{
      await api('/api/admin/users',{json:{name:$('#auName').value.trim(),email:$('#auEmail').value.trim(),password:$('#auPw').value,role:$('#auRole').value}});
      closeModal(); toast('User created'); renderAdmin(); }catch(e){ toast(e.message);} }}]);
}
function resetPwModal(id,email){
  openModal('Reset password — '+email, `<div class="field"><label>New password</label><input id="rpPw" type="text"></div>`,
    [{label:'Update password',cls:'btn',fn:async()=>{ try{
      await api('/api/admin/users/'+id,{method:'PATCH',json:{password:$('#rpPw').value}});
      closeModal(); toast('Password updated'); }catch(e){ toast(e.message);} }}]);
}

// ============ SCREEN PREVIEW / STOP ============
async function previewScreen(id,name){
  let d; try{ d=await api('/api/screens/'+id+'/nowplaying'); }catch(e){ toast(e.message); return; }
  const status=`${d.online?'🟢 online':'⚪ offline'} • ${d.paused?'⏸ paused':'▶ playing'}`;
  const items=(d.playlist||[]).map((it,i)=>`<div class="chk-row">
    <div class="mini" style="display:grid;place-items:center;color:#fff">${it.type==='video'?'▶':it.type==='website'?'🌐':'🖼'}</div>
    <div><div style="font-weight:600;font-size:13px">${i+1}. ${esc(it.title||'item')}</div>
    <div style="color:var(--muted);font-size:12px">${it.type} • ${(it.duration?it.duration+'s':'full')}</div></div></div>`).join('') || '<p style="color:var(--muted)">Nothing assigned yet.</p>';
  // live mirror: embed the SAME player, locked to this screen's device, muted preview
  const mirror = d.device_id
    ? `<iframe src="/player.html?device_id=${encodeURIComponent(d.device_id)}&preview=1" style="width:100%;aspect-ratio:16/9;border:0;border-radius:10px;background:#000"></iframe>`
    : `<div style="width:100%;aspect-ratio:16/9;background:#000;border-radius:10px;display:grid;place-items:center;color:#6b7280">Not connected</div>`;
  openModal('Live preview — '+name, `
    <div style="margin-bottom:10px;color:var(--muted)">${status} — shows exactly what's on the TV</div>
    ${mirror}
    <div style="font-size:12px;color:var(--muted);margin:10px 0 4px">Playlist (${(d.playlist||[]).length})</div>
    <div class="chk-list" style="max-height:150px">${items}</div>`,
    [{label:d.paused?'▶ Resume screen':'⏸ Stop screen',cls:d.paused?'btn':'btn red',fn:async()=>{
      try{ await api('/api/screens/'+id,{method:'PATCH',json:{paused:d.paused?0:1}});
        toast(d.paused?'Screen resumed':'Screen stopped'); renderScreens();
        previewScreen(id,name); // refresh in place (button toggles, mirror reflects state)
      }catch(e){ toast(e.message);} }}]);
}

// ============ MODAL ============
function openModal(title,bodyHTML,actions=[]){
  const root=$('#modalRoot');
  root.innerHTML=`<div class="overlay">
    <div class="modal"><header>${esc(title)}<button class="x" onclick="closeModal()">×</button></header>
    <div class="body">${bodyHTML}</div><div class="foot" id="modalFoot"></div></div></div>`;
  const foot=$('#modalFoot');
  foot.appendChild(Object.assign(el('button','btn ghost sm','Cancel'),{onclick:closeModal}));
  actions.forEach(a=>{ const b=el('button',(a.cls||'btn')+' sm',a.label); b.onclick=a.fn; foot.appendChild(b); });
}
function closeModal(){ try{ clearTimeout(_pvTimer); }catch(e){} $('#modalRoot').innerHTML=''; }

// ============ BOOT ============
(async function boot(){
  if(token){ try{ me=await api('/api/me'); enterApp(); return; }catch{ token=null; localStorage.removeItem('infotv_token'); } }
  $('#auth').classList.remove('hidden');
})();
