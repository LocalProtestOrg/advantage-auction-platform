/* Website widget storefront (public/embed/storefront.html): the shop grid and the in-frame item view. */
(function () {
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  // Only links to this platform are ever rendered (the server builds them; this is a second check).
  function safeUrl(u){u=String(u||'');return /^https?:\/\//i.test(u)?u:'#';}
  function money(c){if(c==null)return '';var n=Number(c)/100;return '$'+n.toLocaleString('en-US',{minimumFractionDigits:n%1?2:0,maximumFractionDigits:2});}
  var UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var root=document.getElementById('sw-root');
  var SELLER='';try{SELLER=new URLSearchParams(location.search).get('seller')||'';}catch(e){}
  if(!UUID.test(SELLER)){root.innerHTML='<div class="sw-empty">This shop is not available right now.</div>';return;}
  var FEED=null, CHECKOUT=false, listScroll=0;
  // Website pass: signed by the server only when the browser loaded this page inside another website's frame. It is handed
  // to checkout in the link's #fragment (never sent to a server by the browser); the server verifies it. Kept for this
  // frame's session so moving between items here keeps it.
  var PASS='';
  try{var mp=document.querySelector('meta[name="adv-website-pass"]');PASS=(mp&&mp.getAttribute('content'))||'';}catch(e){}
  try{if(PASS)sessionStorage.setItem('adv-wp-'+SELLER,PASS);else PASS=sessionStorage.getItem('adv-wp-'+SELLER)||'';}catch(e){}
  function withPass(u){return PASS?u+'#wp='+encodeURIComponent(PASS):u;}

  function itemFromUrl(){try{var v=new URLSearchParams(location.search).get('item')||'';return UUID.test(v)?v.toLowerCase():'';}catch(e){return '';}}
  function urlFor(id){var p=new URLSearchParams(location.search);if(id)p.set('item',id);else p.delete('item');return location.pathname+'?'+p.toString();}
  function head(s,extra){
    var logo=s.logo_url?'<span class="sw-logo" style="background-image:url(\''+esc(safeUrl(s.logo_url))+'\')" role="img" aria-label="'+esc(s.name||'Shop')+' logo"></span>':'';
    return '<div class="sw-head"><div class="sw-brand">'+logo+'<p class="sw-co">'+esc(s.name||'Shop')+'</p></div>'+(extra||'')+'</div>';
  }
  function foot(){var s=FEED.seller||{},att=FEED.attribution||{};
    return '<p class="sw-foot"><a href="'+esc(safeUrl(att.url||s.storefront_url))+'" target="_blank" rel="noopener">'+esc(att.label||'Shop securely on Advantage.Bid')+'</a></p>';}

  function card(it){
    var loc=[it.city,it.state].filter(Boolean).map(esc).join(', ');
    var img=it.image?'<img class="sw-img" src="'+esc(it.image)+'" alt="'+esc(it.image_alt||it.title)+'" loading="lazy" decoding="async">':'<div class="sw-noimg">No photo</div>';
    // The link keeps a real address (works in a new tab too); a normal click opens the item here, inside the shop.
    return '<a class="sw-card" data-item="'+esc(it.id)+'" href="'+esc(urlFor(it.id))+'">'+img
      +'<div class="sw-body"><p class="sw-title">'+esc(it.title)+'</p>'
      +(it.price_cents!=null?'<div class="sw-price">'+esc(money(it.price_cents))+'</div>':'')
      +'<div class="sw-meta">'+(loc?'<span>'+loc+'</span>':'')+'<span class="sw-pill">'+(it.shippable?'Shipping available':'Local pickup')+'</span></div>'
      +'<span class="sw-cta">View details</span></div></a>';
  }
  function renderList(){
    var s=FEED.seller||{},list=FEED.items||[];
    document.title=(s.name||'Shop')+' | Shop';
    root.innerHTML=head(s,'<span class="sw-count">'+list.length+' item'+(list.length===1?'':'s')+' available</span>')
      +(list.length?'<div class="sw-grid">'+list.map(card).join('')+'</div>':'<div class="sw-empty">No items are available right now. Please check back soon.</div>')+foot();
    root.querySelectorAll('a.sw-card').forEach(function(a){a.addEventListener('click',function(e){
      if(e.metaKey||e.ctrlKey||e.shiftKey||e.button)return;   // a new tab still gets the address
      e.preventDefault();listScroll=window.scrollY;open(a.getAttribute('data-item'),true);});});
    window.scrollTo(0,listScroll);
  }
  function renderItem(it){
    var s=FEED.seller||{};
    document.title=it.title+' | '+(s.name||'Shop');
    var loc=[it.city,it.state].filter(Boolean).join(', ');
    var ship=(it.shipping&&it.shipping.summary)||(it.shippable?'Shipping available':'Local pickup');
    var canonical=safeUrl(it.url);
    var buy=CHECKOUT
      ? '<div class="sw-buy"><a class="sw-btn" href="'+esc(withPass(canonical+(canonical.indexOf('?')<0?'?':'&')+'ref=widget'))+'" target="_blank" rel="noopener">Buy Now</a>'
        +'<p class="sw-small">Secure checkout through Advantage.Bid opens in a new tab, so this page stays open.</p></div>'
      : '<div class="sw-buy"><a class="sw-btn" href="'+esc(safeUrl(s.storefront_url)+'#contact')+'" target="_blank" rel="noopener">Contact Seller</a>'
        +'<p class="sw-small">Ask '+esc(s.name||'the seller')+' about this item.</p></div>';
    root.innerHTML='<button type="button" class="sw-back" id="sw-back"><span aria-hidden="true">←</span> Back to Storefront</button>'
      +'<div class="sw-item"><div id="sw-gallery"></div><div>'
      +'<h1>'+esc(it.title)+'</h1>'
      +(it.price_cents!=null?'<div class="sw-price">'+esc(money(it.price_cents))+'</div>':'')
      +'<div class="sw-meta">'+(it.condition?'<span class="sw-pill">'+esc(it.condition)+'</span>':'')+'<span class="sw-pill">'+(it.shippable?'Shipping available':'Local pickup')+'</span></div>'
      +(loc?'<p class="sw-facts">'+esc(loc)+'</p>':'')
      +'<p class="sw-facts"><b>Shipping and pickup:</b> '+esc(ship)+'</p>'
      +(it.dimensions?'<p class="sw-facts"><b>Dimensions:</b> '+esc(it.dimensions)+'</p>':'')
      +(it.material?'<p class="sw-facts"><b>Material:</b> '+esc(it.material)+'</p>':'')
      +buy
      +(it.description?'<div class="sw-desc">'+esc(it.description)+'</div>':'')
      +'<p class="sw-small"><a href="'+esc(withPass(canonical))+'" target="_blank" rel="noopener">View this item on Advantage.Bid</a></p>'
      +'</div></div>'+foot();
    if(window.AdvGallery)AdvGallery.mount(document.getElementById('sw-gallery'),{images:it.images||[],alts:it.image_alt||[],title:it.title});
    var back=document.getElementById('sw-back');
    back.addEventListener('click',function(){ if(history.state&&history.state.swItem&&history.state.fromList)history.back(); else open('',true); });
    window.scrollTo(0,0); back.focus();
  }
  function open(id,push){
    if(push){try{history.pushState({swItem:id||null,fromList:!!id},'',urlFor(id));}catch(e){}}
    if(!id){renderList();return;}
    root.innerHTML=head(FEED.seller||{})+'<div class="sw-empty">Loading item...</div>';
    fetch('/api/public/storefront/widget/'+encodeURIComponent(SELLER)+'/item/'+encodeURIComponent(id),{credentials:'omit'})
      .then(function(r){return r.json();}).then(function(res){
        if(!res||!res.success){root.innerHTML='<button type="button" class="sw-back" id="sw-back"><span aria-hidden="true">←</span> Back to Storefront</button><div class="sw-empty">This item is no longer available.</div>';
          document.getElementById('sw-back').addEventListener('click',function(){open('',true);});return;}
        renderItem(res.data);
      }).catch(function(){root.innerHTML='<div class="sw-empty">This item could not be loaded. Please try again.</div>';});
  }
  window.addEventListener('popstate',function(){ if(FEED) open(itemFromUrl(),false); });

  Promise.all([
    fetch('/api/public/storefront/widget/'+encodeURIComponent(SELLER),{credentials:'omit'}).then(function(r){return r.json();}),
    fetch('/api/marketplace/config',{credentials:'omit'}).then(function(r){return r.json();}).catch(function(){return {};})
  ]).then(function(a){
    var res=a[0]; CHECKOUT=!!(a[1]&&a[1].data&&a[1].data.checkout_enabled);
    if(!res||!res.success){root.innerHTML='<div class="sw-empty">This shop is not available right now.</div>';return;}
    FEED=res.data; open(itemFromUrl(),false);
  }).catch(function(){root.innerHTML='<div class="sw-empty">Items could not be loaded. Please try again later.</div>';});
})();
