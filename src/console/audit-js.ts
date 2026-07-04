// Audit view browser JS. Same template-literal rules as inbox-js/glance-js:
// this is browser JS inside a TS template literal, so no backticks or
// dollar-brace, double-escape backslashes, and esc() every dynamic value.
// Read-only by design: nothing in here can send, approve, or mutate anything.
export const auditJs = `
// --- Audit: mail trail with provenance (loadAudit on startup + filter change) ---
var audOldest=null;
function audChipHtml(t,cls){ return '<span class="aud-chip '+cls+'">'+esc(t)+'</span>'; }
function audRowHtml(m){
  var d=new Date(m.at);
  var ts=isNaN(d.getTime())?esc(m.at||''):esc(d.toLocaleString());
  var who=m.direction==='inbound'?(m.from||''):(m.to||'');
  var dir=m.direction==='inbound'?audChipHtml('received','aud-in'):audChipHtml('sent','aud-out');
  var via='';
  if(m.direction==='outbound'){
    if(m.sentVia==='auto') via=audChipHtml('sent automatically','aud-auto');
    else if(m.sentVia==='approved') via=audChipHtml('approved by you','aud-appr');
    else via=audChipHtml('system message','aud-sys');
  }
  var cat=m.category?audChipHtml(m.category,'aud-cat'):'';
  return '<div class="aud-row" onclick="audToggle(this)">'
    +'<div class="aud-head">'+dir+via+'<span class="aud-who">'+esc(who)+'</span>'
    +'<span class="aud-subj">'+esc(m.subject||'(no subject)')+'</span>'+cat
    +'<span class="aud-time">'+ts+'</span></div>'
    +'<div class="aud-full" hidden>'+esc(m.body||'')+'</div></div>';
}
function audToggle(row){ var b=row.querySelector('.aud-full'); if(b) b.hidden=!b.hidden; }
function audRender(list,append){
  var box=el('aud-list'); if(!box) return;
  var htmlStr='';
  for(var i=0;i<list.length;i++) htmlStr+=audRowHtml(list[i]);
  if(append){ box.insertAdjacentHTML('beforeend',htmlStr); }
  else { box.innerHTML=htmlStr||'<p class="muted">No messages yet. Every email received or sent will appear here.</p>'; }
  if(list.length) audOldest=list[list.length-1].at;
}
async function loadAudit(){
  setMsg('aud-msg','Loading…','muted');
  try{
    var dirSel=el('aud-direction');
    var body={};
    if(dirSel&&dirSel.value) body.direction=dirSel.value;
    var r=await api('/audit',body);
    if(!r.ok){ setMsg('aud-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    audRender(r.messages,false);
    var more=el('aud-more'); if(more) more.hidden=!r.more;
    setMsg('aud-msg','','muted');
  }catch(e){ setMsg('aud-msg','Could not load the audit log.','no'); }
}
async function loadOlderAudit(){
  if(!audOldest) return;
  try{
    var dirSel=el('aud-direction');
    var body={before:audOldest};
    if(dirSel&&dirSel.value) body.direction=dirSel.value;
    var r=await api('/audit',body);
    if(!r.ok) return;
    audRender(r.messages,true);
    var more=el('aud-more'); if(more) more.hidden=!r.more;
  }catch(e){}
}
`;
