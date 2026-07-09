// Profitability agent view browser JS. Same template-literal rules as the other
// *-js modules: browser JS inside a TS template literal - no backticks or dollar-
// brace, '+' concatenation, esc() every dynamic value, double-escape backslashes.
// Reuses the shared helpers el(), esc(), setMsg(), api(), prtArm().
export const profitJs = `
// --- Profitability: the active adjust-or-drop agent window ---
var pfState={rows:[],config:null,recentActions:[]};
function pfChip(v){
  if(v==='reject') return '<span class="pf-chip pf-reject">reject</span>';
  if(v==='review') return '<span class="pf-chip pf-review">review</span>';
  return '<span class="pf-chip pf-pass">pass</span>';
}
function pfMoney(n){ return (n===null||n===undefined)?'-':('GBP '+Number(n).toFixed(2)); }
function pfActionHtml(r){
  if(!r.action) return '';
  var dry=(r.dryRun===1);
  var label;
  if(r.action==='reprice') label=(dry?'would reprice':'repriced');
  else if(r.action==='drop') label=(dry?'would drop':'dropped');
  else if(r.action==='flag') label='flagged';
  else label='kept';
  return '<span class="pf-chip pf-act'+(dry?' dry':'')+'">'+esc(label)+'</span>';
}
function pfRowHtml(r){
  var neg=(r.netGbp!==null&&r.netGbp<0);
  var name=r.handle?r.handle:r.cjPid;
  var h='<div class="pf-row"><div class="pf-head"><span class="pf-name">'+esc(name)+'</span>'+pfChip(r.verdict)+pfActionHtml(r);
  if(r.linkState==='archived') h+='<span class="pf-chip pf-arch">archived</span>';
  h+='<span class="pf-net '+(neg?'neg':'pos')+'">net '+esc(pfMoney(r.netGbp))
    +(r.netPct!==null?(' ('+Math.round(r.netPct*100)+'%)'):'')+'</span></div>';
  var meta='<span><strong>Our price</strong> '+esc(pfMoney(r.ourRetailGbp))+'</span>';
  if(r.action==='reprice'&&r.fromGbp!==null&&r.toGbp!==null)
    meta+=' &middot; <span><strong>Move</strong> '+esc(pfMoney(r.fromGbp))+' &rarr; '+esc(pfMoney(r.toGbp))+'</span>';
  if(r.competitorGbp!==null&&r.competitorGbp>0){
    meta+=' &middot; <span><strong>UK delivered</strong> ~'+esc(pfMoney(r.competitorGbp))
      +(r.competitorConfidence?(' ('+esc(r.competitorConfidence)+')'):'')+'</span>';
    if(r.sources&&r.sources.length) meta+=' &middot; '+esc(r.sources.join(', '));
  }
  h+='<div class="pf-meta">'+meta+'</div>';
  if(r.reason) h+='<div class="pf-meta">'+esc(r.reason)+'</div>';
  if(r.verdict!=='pass'&&r.linkState&&r.linkState!=='archived'&&r.productId){
    // Delegated click (see the IIFE below): the pid rides a data- attribute,
    // never an inline JS string, so nothing dynamic is interpolated into code.
    h+='<div class="pf-actions"><button type="button" class="ghost" data-pf-pid="'+esc(r.cjPid)+'">Archive (confirm)</button></div>';
  }
  return h+'</div>';
}
function pfBanner(c){
  var b=el('pf-banner'); if(!b) return;
  if(!c||!c.enabled){ b.hidden=true; return; }
  b.hidden=false;
  if(c.dryRun!==false){ b.className='pf-banner preview'; b.textContent='Preview mode - the agent is computing actions but NOT changing anything. Uncheck Preview only to go full auto.'; }
  else{ b.className='pf-banner live'; b.textContent='LIVE - the agent is adjusting prices and dropping unprofitable products automatically, on real numbers, every 15 minutes.'; }
}
function pfLedgerHtml(a){
  var dry=(a.dryRun===1);
  var what;
  if(a.action==='reprice') what=(dry?'would reprice ':'repriced ')+esc(pfMoney(a.fromGbp))+' &rarr; '+esc(pfMoney(a.toGbp));
  else what=(dry?'would drop':'dropped');
  var mkt=(a.competitorGbp!==null&&a.competitorGbp>0)?('vs market ~'+esc(pfMoney(a.competitorGbp))
    +(a.competitorConfidence?(' ('+esc(a.competitorConfidence)+')'):'')):'';
  var tag=dry?'<span class="pf-chip pf-act dry">preview</span>':'<span class="pf-chip pf-act">live</span>';
  return '<div class="pf-led"><span class="pf-when">'+esc(new Date(a.createdAt).toLocaleString())+'</span>'
    +'<span class="pf-what">'+what+'</span><span>'+mkt+'</span>'+tag+'</div>';
}
function pfRenderLedger(){
  var box=el('pf-ledger'); if(!box) return;
  var a=pfState.recentActions||[];
  if(!a.length){ box.innerHTML='<p class="muted">No actions yet.</p>'; return; }
  var s=''; for(var i=0;i<a.length;i++) s+=pfLedgerHtml(a[i]); box.innerHTML=s;
}
function pfRender(){
  var c=pfState.config||{};
  var en=el('pf-enabled'); if(en) en.checked=!!c.enabled;
  var dr=el('pf-dryrun'); if(dr){ dr.checked=(c.dryRun!==false); dr.disabled=!c.enabled; }
  var hb=el('pf-hardblock'); if(hb){ hb.checked=!!c.hardBlock; hb.disabled=!c.enabled; }
  pfBanner(c);
  var th=el('pf-thresholds');
  if(th) th.innerHTML='Thresholds (tune in tenant_config.profit): net floor <strong>'
    +esc(pfMoney(c.minNetAfterAdsGbp))+'/unit</strong>, ad share <strong>'
    +Math.round((c.adShareOfRevenue||0)*100)+'%</strong> of revenue; it prices just under the market delivered price.';
  var box=el('pf-list');
  if(box){
    if(!pfState.rows.length){ box.innerHTML='<p class="muted">No decisions yet. Turn on the agent and run it.</p>'; }
    else{ var s=''; for(var i=0;i<pfState.rows.length;i++) s+=pfRowHtml(pfState.rows[i]); box.innerHTML=s; }
  }
  pfRenderLedger();
}
function pfSummary(sm){
  var el2=el('pf-summary'); if(!el2||!sm) return;
  if(!sm.total){ el2.textContent='Nothing evaluated yet.'; return; }
  el2.textContent=sm.reject+' to drop, '+sm.review+' to review of '+sm.total+' evaluated'
    +(sm.lastCheckedAt?(' - last '+new Date(sm.lastCheckedAt).toLocaleString()):'');
}
async function pfLoad(){
  try{
    var r=await api('/profit',{});
    if(!r.ok){ setMsg('pf-msg','Failed to load.','no'); return; }
    pfState.config=r.config; pfState.rows=r.rows; pfState.recentActions=r.recentActions||[]; pfRender(); pfSummary(r.summary);
  }catch(e){ setMsg('pf-msg','Could not load.','no'); }
}
async function pfSetFlag(flag,on){
  var body={}; body[flag]=!!on;
  setMsg('pf-msg','Saving…','muted');
  try{
    var r=await api('/profit/config',body);
    if(!r.ok){ setMsg('pf-msg','Failed: '+(r.error||'unknown'),'no'); return; }
    var m;
    if(flag==='enabled') m=on?'Agent on (starts in preview).':'Agent off (dormant).';
    else if(flag==='dryRun') m=on?'Preview only - nothing will change.':'FULL AUTO - the agent will now adjust and drop for real.';
    else m=on?'Enforce on.':'Enforce off.';
    setMsg('pf-msg',m,'ok');
    pfLoad();
  }catch(e){ setMsg('pf-msg','Could not save.','no'); }
}
async function pfRunNow(btn){
  if(!pfState.config||!pfState.config.enabled){ setMsg('pf-msg','Turn on the agent first.','no'); return; }
  if(btn) btn.disabled=true;
  var offset=0, guard=0;
  try{
    while(guard++<200){
      var r=await api('/profit/run',{offset:offset});
      if(!r.ok){ setMsg('pf-msg','Run failed: '+(r.error||'unknown'),'no'); break; }
      if(btn) btn.textContent='Working '+Math.min(r.offset+r.scanned,r.total)+'/'+r.total+'…';
      await pfLoad(); // fill the summary + table + ledger live as it walks the catalog
      if(r.next===null||r.next===undefined){ setMsg('pf-msg',(r.dryRun?'Preview complete.':'Run complete.'),'ok'); break; }
      offset=r.next;
    }
  }catch(e){ setMsg('pf-msg','Run stopped.','no'); }
  if(btn){ btn.disabled=false; btn.textContent='Run now'; }
  pfLoad();
}
async function pfArchive(btn,pid){
  if(!prtArm(btn,'Click again to archive')) return;
  try{
    var r=await api('/profit/archive',{cjPid:pid});
    if(!r.ok){ setMsg('pf-msg','Archive failed: '+(r.error||'unknown'),'no'); return; }
    setMsg('pf-msg','Archived.','ok');
    pfLoad();
  }catch(e){ setMsg('pf-msg','Could not archive.','no'); }
}
(function(){
  var list=el('pf-list');
  if(list) list.addEventListener('click',function(e){
    var btn=e.target&&e.target.closest?e.target.closest('[data-pf-pid]'):null;
    if(!btn) return;
    pfArchive(btn,btn.getAttribute('data-pf-pid'));
  });
})();
`;
