// Audit view v2 browser JS. Same template-literal rules as inbox-js/glance-js:
// browser JS inside a TS template literal - no backticks or dollar-brace,
// double-escape backslashes, esc() every dynamic value. Read-only by design:
// nothing in here can send, approve, or mutate anything.
//
// XSS note: contact emails and names are attacker-controlled (they arrive in
// inbound mail), so rows carry the email in an ESCAPED data attribute and the
// click is resolved by delegation - the email is never string-built into an
// inline onclick handler.
export const auditJs = `
// --- Audit: contact list + conversation modal (loadAudit on startup + filter) ---
var audOldest=null;
function audChipHtml(t,cls){ return '<span class="aud-chip '+cls+'">'+esc(t)+'</span>'; }
function audWhen(iso){ var d=new Date(iso); return isNaN(d.getTime())?esc(iso||''):esc(d.toLocaleString()); }
function audContactRowHtml(c){
  var cats='';
  for(var i=0;i<(c.categories||[]).length;i++) cats+=audChipHtml(c.categories[i],'aud-cat');
  var count=(c.messages||0)+(c.messages===1?' message':' messages');
  return '<div class="aud-row" data-aud-email="'+esc(c.email)+'">'
    +'<div class="aud-head"><span class="aud-who">'+esc(c.name||c.email)+'</span>'
    +(c.name?'<span class="aud-mail">'+esc(c.email)+'</span>':'')
    +cats+'<span class="muted" style="font-size:12px">'+esc(count)+'</span>'
    +'<span class="aud-time">'+audWhen(c.lastAt)+'</span></div></div>';
}
function audRender(list,append){
  var box=el('aud-list'); if(!box) return;
  var htmlStr='';
  for(var i=0;i<list.length;i++) htmlStr+=audContactRowHtml(list[i]);
  if(append){ box.insertAdjacentHTML('beforeend',htmlStr); }
  else { box.innerHTML=htmlStr||'<p class="muted">No conversations yet. Everyone who emails the shop will appear here.</p>'; }
  if(list.length) audOldest=list[list.length-1].lastAt;
}
async function loadAudit(){
  setMsg('aud-msg','Loading…','muted');
  try{
    var sel=el('aud-category');
    var body={};
    if(sel&&sel.value) body.category=sel.value;
    var r=await api('/audit',body);
    if(!r.ok){ setMsg('aud-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    audRender(r.contacts,false);
    var more=el('aud-more'); if(more) more.hidden=!r.more;
    setMsg('aud-msg','','muted');
  }catch(e){ setMsg('aud-msg','Could not load the audit log.','no'); }
}
async function loadOlderAudit(){
  if(!audOldest) return;
  try{
    var sel=el('aud-category');
    var body={before:audOldest};
    if(sel&&sel.value) body.category=sel.value;
    var r=await api('/audit',body);
    if(!r.ok) return;
    audRender(r.contacts,true);
    var more=el('aud-more'); if(more) more.hidden=!r.more;
  }catch(e){}
}
// --- Conversation modal ---
function audMsgBlockHtml(m){
  var dir=m.direction==='inbound'?audChipHtml('received','aud-in'):audChipHtml('sent','aud-out');
  var via='';
  if(m.direction==='outbound'){
    if(m.sentVia==='auto') via=audChipHtml('sent automatically','aud-auto');
    else if(m.sentVia==='approved') via=audChipHtml('approved by you','aud-appr');
    else via=audChipHtml('system message','aud-sys');
  }
  var cat=m.category?audChipHtml(m.category,'aud-cat'):'';
  return '<div class="aud-msg-block">'
    +'<div class="aud-msg-meta">'+dir+via+cat
    +'<span class="aud-subj">'+esc(m.subject||'(no subject)')+'</span>'
    +'<span class="aud-time">'+audWhen(m.at)+'</span></div>'
    +'<div class="aud-body">'+esc(m.body||'')+'</div></div>';
}
async function openAuditConvo(email){
  try{
    var r=await api('/audit/conversation',{email:email});
    if(!r.ok){ setMsg('aud-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    var title=el('aud-convo-title');
    if(title) title.textContent=(r.contact.name?r.contact.name+' - ':'')+r.contact.email;
    var box=el('aud-convo');
    if(box){
      var htmlStr='';
      for(var i=0;i<r.messages.length;i++) htmlStr+=audMsgBlockHtml(r.messages[i]);
      box.innerHTML=htmlStr||'<p class="muted">No messages with this contact.</p>';
      box.scrollTop=0;
    }
    var ov=el('aud-overlay');
    if(ov){ ov.hidden=false; window.__modalOpen=true; }
  }catch(e){ setMsg('aud-msg','Could not load the conversation.','no'); }
}
function closeAuditConvo(){
  var ov=el('aud-overlay');
  if(ov) ov.hidden=true;
  window.__modalOpen=false;
}
(function(){
  var list=el('aud-list');
  if(list) list.addEventListener('click',function(e){
    var row=e.target&&e.target.closest?e.target.closest('.aud-row'):null;
    if(row&&row.getAttribute('data-aud-email')) openAuditConvo(row.getAttribute('data-aud-email'));
  });
  var ov=el('aud-overlay');
  if(ov) ov.addEventListener('click',function(e){ if(e.target===ov) closeAuditConvo(); });
  window.addEventListener('keydown',function(e){ if(e.key==='Escape'&&window.__modalOpen) closeAuditConvo(); });
})();
`;
