// Traffic view browser JS. Same template-literal rules as the other *-js
// modules: browser JS inside a TS template literal - no backticks or
// dollar-brace, '+' concatenation, esc() every dynamic value, double-escape
// backslashes. Composed after partnersJs (reuses prtArm for the delete).
export const trafficJs = `
// --- Traffic: acquisition strategy board ---
var trfState={channels:[]};
function trfChip(s){
  if(s==='active') return '<span class="trf-chip trf-active">active</span>';
  if(s==='testing') return '<span class="trf-chip trf-testing">testing</span>';
  if(s==='paused') return '<span class="trf-chip trf-paused">paused</span>';
  return '<span class="trf-chip trf-idea">idea</span>';
}
function trfRowHtml(ch){
  var h='<div class="trf-row" data-trf-id="'+esc(ch.id)+'">'
    +'<div class="trf-head"><span class="trf-name">'+esc(ch.name)+'</span>'+trfChip(ch.status)
    +'<span class="trf-prio">priority '+esc(ch.priority)+'</span></div>';
  if(ch.nextAction) h+='<div class="trf-next"><strong>Next:</strong> '+esc(ch.nextAction)+'</div>';
  return h+'</div>';
}
async function loadTraffic(){
  var box=el('trf-list'); if(!box) return;
  try{
    var r=await api('/traffic',{});
    if(!r.ok){ setMsg('trf-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    trfState.channels=r.channels;
    var h='';
    for(var i=0;i<r.channels.length;i++) h+=trfRowHtml(r.channels[i]);
    box.innerHTML=h||'<p class="muted">No channels yet. Add the first one below.</p>';
  }catch(e){ setMsg('trf-msg','Could not load the board.','no'); }
}
function trfFill(ch){
  el('trf-id').value=ch.id||'';
  el('trf-name').value=ch.name||'';
  el('trf-status').value=ch.status||'idea';
  el('trf-priority').value=String(ch.priority||3);
  el('trf-rationale').value=ch.rationale||'';
  el('trf-next').value=ch.nextAction||'';
  el('trf-notes').value=ch.notes||'';
  var del=el('trf-delete-btn'); if(del) del.hidden=!ch.id;
  var t=el('trf-editor-title'); if(t) t.textContent=ch.id?('Edit: '+ch.name):'New channel';
  var card=el('trf-editor-card'); if(card){ card.hidden=false; card.scrollIntoView({block:'nearest'}); }
  setMsg('trf-editor-msg','','muted');
}
function trfNew(){ trfFill({}); }
function trfCloseEditor(){ var card=el('trf-editor-card'); if(card) card.hidden=true; }
async function trfSave(){
  var body={
    name:el('trf-name').value.trim(),
    status:el('trf-status').value,
    priority:parseInt(el('trf-priority').value,10),
    rationale:el('trf-rationale').value.trim(),
    nextAction:el('trf-next').value.trim(),
    notes:el('trf-notes').value.trim()
  };
  var id=el('trf-id').value; if(id) body.id=id;
  if(!body.name){ setMsg('trf-editor-msg','Give the channel a name.','no'); return; }
  setMsg('trf-editor-msg','Saving…','muted');
  try{
    var r=await api('/traffic/save',body);
    if(!r.ok){ setMsg('trf-editor-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    setMsg('trf-editor-msg','Saved.','ok');
    trfCloseEditor();
    loadTraffic();
  }catch(e){ setMsg('trf-editor-msg','Could not save.','no'); }
}
async function trfDelete(btn){
  var id=el('trf-id').value; if(!id) return;
  if(!prtArm(btn,'Click again to delete')) return;
  try{
    var r=await api('/traffic/delete',{id:id});
    if(!r.ok){ setMsg('trf-editor-msg','Failed: '+(r.error||'unknown error'),'no'); return; }
    trfCloseEditor();
    loadTraffic();
  }catch(e){ setMsg('trf-editor-msg','Could not delete.','no'); }
}
(function(){
  var list=el('trf-list');
  if(list) list.addEventListener('click',function(e){
    var row=e.target&&e.target.closest?e.target.closest('[data-trf-id]'):null;
    if(!row) return;
    var id=row.getAttribute('data-trf-id');
    for(var i=0;i<trfState.channels.length;i++){
      if(trfState.channels[i].id===id){ trfFill(trfState.channels[i]); return; }
    }
  });
})();
`;
