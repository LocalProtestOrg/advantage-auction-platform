/* White-label company auction widget (public/embed/auctions.html): the company's auction list, an auction's catalog and a
   lot's details, all inside the frame on the company's own website (owner request 2026-11-03). Same pattern as the
   storefront widget (public/embed/storefront.js): every view has its own address (?key=&auction=&lot=), the browser Back
   button works (history.pushState / popstate), photos open in the shared gallery (/widgets/shared/image-gallery.js).
   Bidding never happens inside the frame: "Bid on Advantage.Bid" opens the lot's own page in a new tab, where the shopper
   signs in and bids through the platform's normal, authenticated bidding (no second bidding engine). The only message to
   the host page is the widget's height, "show my top" and "photo viewer open/closed" (validated by the loader). */
(function () {
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function q(name){try{return new URLSearchParams(location.search).get(name)||'';}catch(e){return '';}}
  // Only links to this platform are ever rendered (the server builds them; this is a second check).
  function safeUrl(u){u=String(u||'');return /^https?:\/\//i.test(u)||/^\/[^/]/.test(u)?u:'#';}
  function money(c){if(c==null)return '';var n=Number(c)/100;return '$'+n.toLocaleString('en-US',{minimumFractionDigits:n%1?2:0,maximumFractionDigits:2});}
  var UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var root=document.getElementById('wl-root');
  var KEY=q('key');
  // Demo-only presentation mode (?demo=1): illustrative data, NO key, NO API call, NO install code. Used only inside the
  // private sales demo's example company website. Its buttons open a real PUBLIC auction on the platform.
  var DEMO=q('demo')==='1';
  var LIST=null, listScroll=0, catScroll=0, CATALOG=null;

  function post(msg){try{if(window.parent&&window.parent!==window)window.parent.postMessage(msg,'*');}catch(e){}}
  // Only ever send a numeric height to the parent; the loader validates source + shape. No data leaves here.
  function postHeight(){var h=document.documentElement.scrollHeight||document.body.scrollHeight||0;post({ type: 'adv-wl-height', height: h });}
  function fmtDate(t){if(!t)return '';try{return new Date(t).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});}catch(e){return '';}}
  function fmtWhen(t){if(!t)return '';try{return new Date(t).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});}catch(e){return '';}}
  function pct(bps){return (Number(bps)/100).toLocaleString('en-US',{maximumFractionDigits:2})+'%';}

  function demoCover(a,b){
    var svg='<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
      +'<stop offset="0" stop-color="'+a+'"/><stop offset="1" stop-color="'+b+'"/></linearGradient></defs><rect width="480" height="300" fill="url(#g)"/></svg>';
    return 'data:image/svg+xml,'+encodeURIComponent(svg);
  }
  function demoData(){
    var MAPLE='/auction-view.html?auctionId=00000000-0000-4000-a000-0000000d0003';
    return { company: { name: 'Brookfield Estate Auctions' },
      current: [ { title: 'The Maplewood Estate Collection', lots: 146, city: 'Maplewood', state: 'NJ', cover_image_url: demoCover('#1e3a5f', '#0f172a'), href: MAPLE } ],
      upcoming: [
        { title: 'Fine Art & Antiques - Fall Sale', lots: 88, city: 'Ridgewood', state: 'NJ', start_time: '2026-10-04T15:00:00Z', cover_image_url: demoCover('#334155', '#1e293b'), href: MAPLE },
        { title: 'Mid-Century Modern & Design', lots: 54, city: 'Montclair', state: 'NJ', start_time: '2026-10-18T15:00:00Z', cover_image_url: demoCover('#3f6212', '#1a2e05'), href: MAPLE },
        { title: 'Jewelry, Coins & Collectibles', lots: 120, city: 'Summit', state: 'NJ', start_time: '2026-11-01T15:00:00Z', cover_image_url: demoCover('#7c2d12', '#431407'), href: MAPLE } ] };
  }

  // ── addresses: each view is a real address inside the frame ─────────────────────────────────────────────────────
  function viewFromUrl(){var a=q('auction'),l=q('lot');return {auction:UUID.test(a)?a.toLowerCase():'',lot:UUID.test(l)?l.toLowerCase():''};}
  function urlFor(v){var p=new URLSearchParams(location.search);['auction','lot'].forEach(function(k){if(v[k])p.set(k,v[k]);else p.delete(k);});return location.pathname+'?'+p.toString();}
  function go(v,push){
    if(push){try{history.pushState({wl:true,from:viewFromUrl()},'',urlFor(v));}catch(e){}}
    if(v.lot)openLot(v.lot,v.auction);else if(v.auction)openCatalog(v.auction);else renderList();
  }
  function inFrame(a,v,save){   // a normal click opens the view here; a modified click (new tab) keeps the address
    a.addEventListener('click',function(e){if(e.metaKey||e.ctrlKey||e.shiftKey||e.button)return;e.preventDefault();if(save)save();go(v,true);});
  }
  function backBtn(label,v){
    return {html:'<button type="button" class="wl-back" id="wl-back"><span aria-hidden="true">&larr;</span> '+esc(label)+'</button>',
      wire:function(){var b=document.getElementById('wl-back');b.addEventListener('click',function(){
        var st=history.state; if(st&&st.wl&&st.from&&st.from.auction===(v.auction||'')&&st.from.lot===(v.lot||''))history.back(); else go(v,true);});b.focus({preventScroll:true});}};
  }
  function shown(scroll){window.scrollTo(0,scroll||0);postHeight();if(!scroll)post({ type: 'adv-wl-top' });setTimeout(postHeight,250);}

  // ── list of auctions ───────────────────────────────────────────────────────────────────────────────────────────
  function card(a,live){
    var loc=[a.city,a.state].filter(Boolean).map(esc).join(', ');
    var when=live?'Bidding open now':(a.start_time?('Starts '+esc(fmtDate(a.start_time))):'Upcoming');
    var img=a.cover_image_url?'<img class="wl-thumb" src="'+esc(a.cover_image_url)+'" alt="'+esc(a.title||'Auction')+'" loading="lazy">':'<div class="wl-thumb"></div>';
    // A real auction opens its catalog inside the frame; the demo's illustrative cards open the public example auction.
    var cta=DEMO||!a.id
      ? '<a class="wl-cta" href="'+esc(safeUrl(a.href))+'" target="_blank" rel="noopener">'+(live?'View Lots':'View Auction')+'</a>'
      : '<a class="wl-cta" data-auction="'+esc(a.id)+'" href="'+esc(urlFor({auction:a.id}))+'">'+(live?'View Lots':'View Auction')+'</a>';
    return '<div class="wl-card">'+img+'<div class="wl-body">'
      +'<span class="wl-chip '+(live?'wl-live':'wl-up')+'">'+(live?'Live':'Upcoming')+'</span>'
      +'<p class="wl-title">'+esc(a.title||'Auction')+'</p>'
      +'<div class="wl-meta">'+esc(when)+(a.lots?(' · '+a.lots+' lot'+(a.lots===1?'':'s')):'')+'</div>'
      +(loc?('<div class="wl-meta">'+loc+'</div>'):'')+cta+'</div></div>';
  }
  function renderList(){
    var data=LIST||{},cur=data.current||[],up=data.upcoming||[];
    document.title='Auctions';
    if(!cur.length&&!up.length){root.innerHTML='<div class="wl-empty">No auctions are scheduled right now. Please check back soon.</div>';postHeight();return;}
    var html='';
    if(data.company&&data.company.name)html+='<div class="wl-co">'+esc(data.company.name)+': Auctions</div>';
    if(cur.length)html+='<div class="wl-sec">Live now</div><div class="wl-grid">'+cur.map(function(a){return card(a,true);}).join('')+'</div>';
    if(up.length)html+='<div class="wl-sec">Upcoming</div><div class="wl-grid">'+up.map(function(a){return card(a,false);}).join('')+'</div>';
    root.innerHTML=html;
    root.querySelectorAll('a.wl-cta[data-auction]').forEach(function(a){inFrame(a,{auction:a.getAttribute('data-auction')},function(){listScroll=window.scrollY;});});
    shown(listScroll);
  }

  // ── an auction's catalog ───────────────────────────────────────────────────────────────────────────────────────
  function bidLine(l){
    if(l.state==='closed')return 'Bidding closed';
    if(l.current_bid_cents!=null&&l.bid_count>0)return 'Current bid '+money(l.current_bid_cents)+' · '+l.bid_count+' bid'+(l.bid_count===1?'':'s');
    return 'Starting bid '+money(l.starting_bid_cents!=null?l.starting_bid_cents:100);
  }
  function auctionHead(a){
    var loc=[a.city,a.region].filter(Boolean).join(', ');
    var when=a.state==='active'?(a.end_time?'Lots begin closing '+fmtWhen(a.end_time):'Bidding open now'):(a.start_time?'Bidding opens '+fmtWhen(a.start_time):'Upcoming');
    return '<div class="wl-ahead"><h1 class="wl-h1">'+esc(a.title||'Auction')+'</h1>'
      +'<div class="wl-meta">'+esc(when)+(loc?' · '+esc(loc):'')+'</div>'
      +(a.buyer_premium_bps!=null?'<div class="wl-meta">A '+esc(pct(a.buyer_premium_bps))+' buyer\'s premium is added to each winning bid.</div>':'')
      +'</div>';
  }
  function lotCard(l){
    var img=l.image?'<img class="wl-thumb wl-sq" src="'+esc(l.image)+'" alt="'+esc(l.title||'Lot')+'" loading="lazy" decoding="async">':'<div class="wl-thumb wl-sq wl-noimg">No photo</div>';
    return '<a class="wl-card wl-lot" data-lot="'+esc(l.id)+'" href="'+esc(urlFor({auction:CATALOG.auction.id,lot:l.id}))+'">'+img
      +'<div class="wl-body">'+(l.lot_number?'<div class="wl-meta">Lot '+esc(l.lot_number)+'</div>':'')
      +'<p class="wl-title">'+esc(l.title||'Lot')+'</p><div class="wl-bid">'+esc(bidLine(l))+'</div>'
      +(l.closes_at&&l.state!=='closed'?'<div class="wl-meta">Closes '+esc(fmtWhen(l.closes_at))+'</div>':'')
      +'<span class="wl-link">View lot</span></div></a>';
  }
  function renderCatalog(){
    var a=CATALOG.auction,lots=CATALOG.lots||[],b=backBtn('All Auctions',{});
    document.title=(a.title||'Auction')+' | Catalog';
    root.innerHTML=b.html+auctionHead(a)
      +(a.description?'<div class="wl-desc">'+esc(a.description)+'</div>':'')
      +'<div class="wl-sec">'+lots.length+' lot'+(lots.length===1?'':'s')+'</div>'
      +(lots.length?'<div class="wl-grid wl-lots">'+lots.map(lotCard).join('')+'</div>':'<div class="wl-empty">The catalog is being prepared. Please check back soon.</div>')
      +'<p class="wl-small"><a href="'+esc(safeUrl(a.url))+'" target="_blank" rel="noopener">Open this auction on Advantage.Bid</a></p>';
    root.querySelectorAll('a.wl-lot').forEach(function(x){inFrame(x,{auction:a.id,lot:x.getAttribute('data-lot')},function(){catScroll=window.scrollY;});});
    b.wire(); shown(catScroll);
  }
  function openCatalog(id){
    if(CATALOG&&CATALOG.auction.id===id){renderCatalog();return;}
    catScroll=0; root.innerHTML='<div class="wl-empty">Loading catalog...</div>';postHeight();
    fetch('/api/public/widget/auctions/'+encodeURIComponent(id)+'/lots?key='+encodeURIComponent(KEY),{credentials:'omit'})
      .then(function(r){return r.json();}).then(function(res){
        if(!res||!res.success){unavailable('This auction is not available here.',{});return;}
        CATALOG=res.data; renderCatalog();
      }).catch(function(){unavailable('The catalog could not be loaded. Please try again.',{});});
  }

  // ── one lot ──────────────────────────────────────────────────────────────────────────────────────────────────
  function fact(label,v){return v?'<p class="wl-fact"><b>'+esc(label)+':</b> '+esc(v)+'</p>':'';}
  function renderLot(d){
    var l=d.lot,a=d.auction,b=backBtn('Back to Catalog',{auction:a.id});
    document.title=(l.title||'Lot')+' | '+(a.title||'Auction');
    var open=l.state!=='closed';
    root.innerHTML=b.html+'<div class="wl-item"><div id="wl-gallery"></div><div>'
      +(l.lot_number?'<div class="wl-meta">Lot '+esc(l.lot_number)+' · '+esc(a.title||'')+'</div>':'<div class="wl-meta">'+esc(a.title||'')+'</div>')
      +'<h1 class="wl-h1">'+esc(l.title||'Lot')+'</h1>'
      +'<div class="wl-bid wl-big">'+esc(bidLine(l))+'</div>'
      +(l.closes_at&&open?'<div class="wl-meta">Closes '+esc(fmtWhen(l.closes_at))+'. A bid in the last minutes extends the closing.</div>':'')
      +(a.buyer_premium_bps!=null?'<div class="wl-meta">A '+esc(pct(a.buyer_premium_bps))+' buyer\'s premium is added to the winning bid.</div>':'<div class="wl-meta">The buyer\'s premium is shown before you bid.</div>')
      +(open?'<div class="wl-buy"><a class="wl-btn" href="'+esc(safeUrl(l.url))+'" target="_blank" rel="noopener">Bid on Advantage.Bid</a>'
        +'<p class="wl-small">Secure bidding opens on Advantage.Bid in a new tab, so this page stays open. You sign in there and your bid is placed there.</p></div>'
        :'<div class="wl-buy"><a class="wl-btn wl-btn-mut" href="'+esc(safeUrl(l.url))+'" target="_blank" rel="noopener">View result on Advantage.Bid</a></div>')
      +(l.description?'<div class="wl-desc">'+esc(l.description)+'</div>':'')
      +fact('Condition',l.condition)+fact('Maker or artist',l.maker_artist)+fact('Era',l.era)+fact('Material',l.material)
      +fact('Dimensions',l.dimensions)+fact('Size',l.size_category)+fact('Category',l.category)
      +'<p class="wl-fact">'+(l.shippable?'Shipping available':'Local pickup')+'</p>'
      +'</div></div>';
    if(window.AdvGallery)AdvGallery.mount(document.getElementById('wl-gallery'),{images:l.images||[],title:l.title||'Lot',
      onViewer:function(on){post({ type: 'adv-wl-viewer', open: !!on });}});
    b.wire(); shown(0);
    root.querySelectorAll('#wl-gallery img').forEach(function(i){i.addEventListener('load',postHeight);});
  }
  function openLot(id,auctionId){
    root.innerHTML='<div class="wl-empty">Loading lot...</div>';postHeight();
    fetch('/api/public/widget/lots/'+encodeURIComponent(id)+'?key='+encodeURIComponent(KEY),{credentials:'omit'})
      .then(function(r){return r.json();}).then(function(res){
        if(!res||!res.success){unavailable('This lot is not available here.',auctionId?{auction:auctionId}:{});return;}
        renderLot(res.data);
      }).catch(function(){unavailable('This lot could not be loaded. Please try again.',auctionId?{auction:auctionId}:{});});
  }
  function unavailable(text,backTo){
    var b=backBtn(backTo.auction?'Back to Catalog':'All Auctions',backTo);
    root.innerHTML=b.html+'<div class="wl-empty">'+esc(text)+'</div>'; b.wire(); postHeight();
  }

  window.addEventListener('popstate',function(){ if(LIST) go(viewFromUrl(),false); });
  window.addEventListener('load',postHeight);
  window.addEventListener('resize',postHeight);

  if(DEMO){LIST=demoData();renderList();setTimeout(postHeight,300);return;}
  if(!KEY){root.innerHTML='<div class="wl-empty">Auction widget is not configured.</div>';postHeight();return;}
  fetch('/api/public/widget/auctions?key='+encodeURIComponent(KEY),{credentials:'omit'})
    .then(function(r){return r.json();})
    .then(function(d){LIST=d||{};go(viewFromUrl(),false);})
    .catch(function(){root.innerHTML='<div class="wl-empty">Auctions are temporarily unavailable.</div>';postHeight();});
  setTimeout(postHeight,1200);
})();
