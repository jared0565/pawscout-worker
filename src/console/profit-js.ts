// Profitability agent view browser JS. Same template-literal rules as the other
// *-js modules: browser JS inside a TS template literal - no backticks or dollar-
// brace, '+' concatenation, esc() every dynamic value, double-escape backslashes.
// Reuses the shared helpers el(), esc(), setMsg(), api(), prtArm().
export const profitJs = `
// --- Profitability: the active adjust-or-drop agent window ---
var pfState={rows:[],config:null,recentActions:[],showAll:false};
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
// Review links. CJ: canonical -p-<pid>.html product page. PDP: our storefront
// product page. Competitor: a SEARCH (we hold retailer names, not URLs), so the
// link is honestly a search and the real analysis rides the tooltip.
function pfCjUrl(pid){ return 'https://cjdropshipping.com/product/-p-'+encodeURIComponent(pid)+'.html'; }
function pfPdpUrl(handle){ return 'https://activepaw.co.uk/products/'+encodeURIComponent(handle); }
function pfCompUrl(q){ return 'https://www.google.com/search?q='+encodeURIComponent((q||'')+' uk price'); }
function pfWhen(s){ if(!s) return '-'; try{ return new Date(s).toLocaleString(); }catch(e){ return String(s); } }
var PF_EXT=' <span class="pf-ext">&#8599;</span>';
// One table row per product. Product cell = readable name + SKU + the decision
// reason (all wrap; the cell breaks space-less tokens so nothing collides). Three
// clickable prices (PDP / CJ / Competitor) each carry a tooltip that says exactly
// what the number is - the CJ price is the supplier ITEM price, NOT the landed cost
// behind the net, so it is labelled to avoid reading as broken margin maths.
function pfRowTr(r){
  var name=r.name?r.name:(r.handle?r.handle:r.cjPid);
  var prod='<td class="pf-prod"><span class="pf-pname" title="'+esc(name)+'">'+esc(name)+'</span>'
    +'<span class="pf-sku">'+(r.sku?esc(r.sku):'<span class="pf-none">no SKU</span>')+'</span>';
  if(r.reason) prod+='<div class="pf-why">'+esc(r.reason)+'</div>';
  prod+='</td>';
  // Verdict colour chip (triage) + the specific action.
  var act='<td class="pf-act-cell">'+pfChip(r.verdict)+' '+pfActionHtml(r);
  if(r.linkState==='archived') act+=' <span class="pf-chip pf-arch">archived</span>';
  act+='</td>';
  // PDP: our storefront price, links to the product page (only when we have a handle).
  var pdp='<td class="pf-num">';
  if(r.ourRetailGbp!==null&&r.ourRetailGbp!==undefined){
    if(r.handle) pdp+='<a class="pf-plink" href="'+esc(pfPdpUrl(r.handle))+'" target="_blank" rel="noopener" title="Your storefront price. Click to open the product page (PDP).">'+esc(pfMoney(r.ourRetailGbp))+PF_EXT+'</a>';
    else pdp+=esc(pfMoney(r.ourRetailGbp));
    if(r.action==='reprice'&&r.fromGbp!==null&&r.toGbp!==null) pdp+='<span class="pf-move">'+esc(Number(r.fromGbp).toFixed(2))+' &rarr; '+esc(Number(r.toGbp).toFixed(2))+'</span>';
  } else { pdp+='<span class="pf-none">-</span>'; }
  pdp+='</td>';
  // CJ: supplier ITEM price at import (excl. shipping) - NOT the landed cost behind
  // the net. Always links to the CJ product page even when no price is stored.
  var cjTip=(r.cjPriceGbp!==null&&r.cjPriceGbp!==undefined)
    ? 'CJ item price at import (excludes shipping). This is NOT the landed cost behind the net. Click to open the product in CJ.'
    : 'Open the product in CJ.';
  var cj='<td class="pf-num"><a class="pf-plink" href="'+esc(pfCjUrl(r.cjPid))+'" target="_blank" rel="noopener" title="'+esc(cjTip)+'">'
    +((r.cjPriceGbp!==null&&r.cjPriceGbp!==undefined)?esc(pfMoney(r.cjPriceGbp)):'CJ')+PF_EXT+'</a></td>';
  // Competitor: typical UK delivered price + confidence. The link is a SEARCH; the
  // estimate/confidence/sources (the analysis) live in the tooltip.
  var comp='<td class="pf-num">';
  if(r.competitorGbp!==null&&r.competitorGbp>0){
    var tip='Typical UK delivered price ~'+pfMoney(r.competitorGbp)
      +(r.competitorConfidence?(', '+r.competitorConfidence+' confidence'):'')
      +(r.sources&&r.sources.length?('. Sources: '+r.sources.join(', ')):'')
      +'. Click to search for comparable listings.';
    comp+='<a class="pf-plink" href="'+esc(pfCompUrl(name))+'" target="_blank" rel="noopener" title="'+esc(tip)+'">~'+esc(pfMoney(r.competitorGbp))+PF_EXT+'</a>';
    if(r.competitorConfidence) comp+='<span class="pf-conf">'+esc(r.competitorConfidence)+' conf</span>';
  } else { comp+='<span class="pf-none">no market</span>'; }
  comp+='</td>';
  // Net (coloured) + margin %.
  var neg=(r.netGbp!==null&&r.netGbp<0);
  var net='<td class="pf-num"><span class="'+(neg?'pf-nneg':'pf-npos')+'">'+esc(pfMoney(r.netGbp))+'</span>'
    +(r.netPct!==null?('<span class="pf-move">'+Math.round(r.netPct*100)+'%</span>'):'')+'</td>';
  var when='<td class="pf-when-c">'+esc(pfWhen(r.checkedAt))+'</td>';
  // Row actions (pids ride data- attributes; delegated click in the IIFE below,
  // never inline code): Deep check = the thorough LLM+web market read (costs
  // roughly 30p, so it is a button, not the cron), then an immediate re-judge.
  // Archive = manual fallback (non-pass, live, not-yet-archived).
  var actionCell='<td>';
  if(r.linkState&&r.linkState!=='archived'&&r.productId)
    actionCell+='<button type="button" class="ghost" data-pf-deep="'+esc(r.cjPid)+'">Deep check</button> ';
  if(r.verdict!=='pass'&&r.linkState&&r.linkState!=='archived'&&r.productId)
    actionCell+='<button type="button" class="ghost" data-pf-pid="'+esc(r.cjPid)+'">Archive</button>';
  actionCell+='</td>';
  return '<tr>'+prod+act+pdp+cj+comp+net+when+actionCell+'</tr>';
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
  var ci=el('pf-compimport'); if(ci){ ci.checked=!!c.competitionCheckOnImport; ci.disabled=!c.enabled; }
  var as=el('pf-adshare'); if(as){ as.value=Math.round((c.adShareOfRevenue||0)*100); as.disabled=!c.enabled; }
  var ah=el('pf-adshare-hint');
  if(ah){ var apct=Math.round((c.adShareOfRevenue||0)*100);
    ah.textContent=(apct>=30?'('+apct+'% assumes ~100% paid at ROAS 3 - the worst case; lower it toward your real blend)':'('+apct+'% blended)'); }
  pfBanner(c);
  var th=el('pf-thresholds');
  if(th) th.innerHTML='Net floor <strong>'
    +esc(pfMoney(c.minNetAfterAdsGbp))+'/unit</strong>; it prices just under the market delivered price and keeps at least the floor. Other thresholds are tuned in tenant_config.profit.';
  var box=el('pf-list');
  if(box){
    // Default view = only what needs eyes (review/reject). Passing products are
    // behind the toggle so the list stays short as the catalog grows.
    var all=pfState.rows;
    var need=[]; for(var k=0;k<all.length;k++){ if(all[k].verdict!=='pass') need.push(all[k]); }
    var rows=pfState.showAll?all:need;
    if(!all.length){ box.innerHTML='<p class="muted">No decisions yet. The agent repopulates this list as it walks the catalog (or click Run now).</p>'; }
    else if(!rows.length){ box.innerHTML='<p class="muted">Nothing needs review - all '+all.length+' evaluated products pass. <a href="#" class="pf-plink" onclick="return pfToggleAll()">Show them</a></p>'; }
    else{
      var s='<div class="pf-tablewrap"><table class="pf-table"><thead><tr>'
        +'<th class="pf-c-prod">Product</th>'
        +'<th class="pf-c-act">Decision</th>'
        +'<th class="pf-c-price pf-num">PDP</th>'
        +'<th class="pf-c-price pf-num">CJ</th>'
        +'<th class="pf-c-comp pf-num">Competitor</th>'
        +'<th class="pf-c-price pf-num">Net</th>'
        +'<th class="pf-c-when">Processed</th>'
        +'<th class="pf-c-arch" aria-label="Actions"></th>'
        +'</tr></thead><tbody>';
      for(var i=0;i<rows.length;i++) s+=pfRowTr(rows[i]);
      s+='</tbody></table></div>';
      if(pfState.showAll){
        if(need.length<all.length) s+='<p class="muted" style="margin:8px 4px 0;font-size:12px">Showing all '+all.length+'. <a href="#" class="pf-plink" onclick="return pfToggleAll()">Show only the '+need.length+' needing review</a></p>';
      } else if(all.length>rows.length){
        s+='<p class="muted" style="margin:8px 4px 0;font-size:12px">'+rows.length+' need review; '+(all.length-rows.length)+' passing products hidden. <a href="#" class="pf-plink" onclick="return pfToggleAll()">Show all '+all.length+'</a></p>';
      }
      box.innerHTML=s;
    }
  }
  pfRenderLedger();
}
function pfToggleAll(){ pfState.showAll=!pfState.showAll; pfRender(); return false; }
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
async function pfSetAdShare(pct){
  var n=Number(pct);
  if(!isFinite(n)||n<0||n>60){ setMsg('pf-msg','Enter an ad share between 0 and 60%.','no'); pfLoad(); return; }
  var frac=Math.round(n)/100; // store as a fraction of revenue
  setMsg('pf-msg','Saving…','muted');
  try{
    var r=await api('/profit/config',{adShareOfRevenue:frac});
    if(!r.ok){ setMsg('pf-msg','Failed: '+(r.error||'unknown'),'no'); return; }
    setMsg('pf-msg','Ad share set to '+Math.round(n)+'%. Click Run now to re-preview at the new value.','ok');
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
async function pfClearDecisions(btn){
  if(!prtArm(btn,'Click again to clear ALL')) return;
  btn.disabled=true; setMsg('pf-msg','Clearing…','muted');
  try{
    var r=await api('/profit/clear',{});
    if(!r.ok) setMsg('pf-msg','Clear failed: '+(r.error||'unknown'),'no');
    else setMsg('pf-msg','Cleared '+r.cleared+' decisions and '+r.cacheCleared+' cached market prices. The agent re-researches and re-judges the catalog over the next few hours (or click Run now).','ok');
  }catch(e){ setMsg('pf-msg','Could not clear.','no'); }
  btn.disabled=false; btn.removeAttribute('data-armed');
  btn.textContent=btn.getAttribute('data-orig')||'Clear list & re-judge';
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
async function pfDeep(btn,pid){
  // Costs a real web read (~30p), so two-click confirm like the other actions.
  if(!prtArm(btn,'Costs ~30p - click again')) return;
  btn.disabled=true;
  setMsg('pf-msg','Deep market research running: fresh web read, then an immediate re-judge. Up to a minute.','muted');
  try{
    var r=await api('/profit/deep',{cjPid:pid});
    if(!r.ok){ setMsg('pf-msg','Deep check failed: '+(r.error||'unknown'),'no'); btn.disabled=false; return; }
    var m=r.signal?('market ~'+esc(pfMoney(r.signal.estimateGbp))+' ('+esc(r.signal.confidence)+', '+esc((r.signal.sources||[]).join(', '))+')'):'no usable market found (cost-plus rule applies)';
    setMsg('pf-msg','Deep check done: '+m+'. Decision: '+esc(r.action)+(r.dryRun?' (preview)':'')+' - '+esc(r.reason),'ok');
    pfLoad();
  }catch(e){ setMsg('pf-msg','Could not run the deep check.','no'); }
  btn.disabled=false;
}
(function(){
  var list=el('pf-list');
  if(list) list.addEventListener('click',function(e){
    var deep=e.target&&e.target.closest?e.target.closest('[data-pf-deep]'):null;
    if(deep){ pfDeep(deep,deep.getAttribute('data-pf-deep')); return; }
    var btn=e.target&&e.target.closest?e.target.closest('[data-pf-pid]'):null;
    if(!btn) return;
    pfArchive(btn,btn.getAttribute('data-pf-pid'));
  });
})();
`;
