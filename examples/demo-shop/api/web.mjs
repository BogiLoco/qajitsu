// demo-shop web UI (REQ-NFR-04, stage 5): plain HTML pages served by the API server. Seeded UI bugs are
// switched on by the server and injected as window.__BUGS (see ../BUGS.md).

const page = (title, body, bugs) => `<!doctype html>
<html lang="pl"><head><meta charset="utf-8"><title>${title} · demo-shop</title>
<style>body{font:15px system-ui;margin:24px}nav a{margin-right:12px}.toast{padding:8px;margin:8px 0}.ok{background:#dafbe1}.err{background:#ffebe9}button[disabled]{opacity:.5}</style>
<script>window.__BUGS=${JSON.stringify(bugs)};
const token=()=>sessionStorage.getItem("token");
const api=(path,opts={})=>fetch(path,{...opts,headers:{"content-type":"application/json",authorization:"Bearer "+token(),...(opts.headers||{})}});
const price=(n)=>window.__BUGS.BUG_PRICE_FORMAT_LOCALE?String(Math.round(n*100)/100):new Intl.NumberFormat("pl-PL",{style:"currency",currency:"PLN"}).format(n).replace(/\\u00a0/g," ");
const toast=(text,ok)=>{const t=document.createElement("div");t.className="toast "+(ok?"ok":"err");t.setAttribute("role","status");t.dataset.testid="toast";t.textContent=text;document.body.appendChild(t);};
</script></head><body>
<nav><a href="/app/products" data-testid="nav-products">Products</a><a href="/app/cart" data-testid="nav-cart">Cart</a><a href="/app/checkout" data-testid="nav-checkout">Checkout</a></nav>
<h1>${title}</h1>${body}</body></html>`;

const PAGES = {
  "/app/profile": [
    "Profile",
    `<p><label>Avatar <input type="file" accept="image/png" data-testid="avatar-input" id="av"></label></p>
<div data-testid="avatar-drop" id="drop" style="border:2px dashed #999;padding:24px;width:280px">Drop an image here</div>
<p>Uploaded: <span data-testid="avatar-name"></span> (<span data-testid="avatar-size"></span> bytes)</p>
<script>const send=async(f)=>{const r=await fetch("/profile/avatar",{method:"POST",headers:{"content-type":f.type||"application/octet-stream","x-file-name":f.name,authorization:"Bearer "+token()},body:f});
if(r.ok){const d=await r.json();document.querySelector("[data-testid=avatar-name]").textContent=d.name;document.querySelector("[data-testid=avatar-size]").textContent=String(d.bytes);toast("Avatar saved",true);}
else toast(r.status===413?"File too large":"Upload failed",false);};
document.getElementById("av").onchange=(e)=>{if(e.target.files[0])send(e.target.files[0]);};
const drop=document.getElementById("drop");drop.ondragover=(e)=>e.preventDefault();
drop.ondrop=(e)=>{e.preventDefault();const f=e.dataTransfer.files[0];if(f)send(f);};</script>`,
  ],
  "/app/pay": [
    "Payment",
    `<p>Status: <span data-testid="payment-status">Pending</span></p>
<iframe title="Payment" src="/widget/pay" width="440" height="180"></iframe>
<script>window.addEventListener("message",(e)=>{if(e.origin!==location.origin||!e.data||e.data.type!=="paid")return;
if(!window.__BUGS.BUG_3DS_RESULT_IGNORED)document.querySelector("[data-testid=payment-status]").textContent="Paid";});</script>`,
  ],
  "/app/board": [
    "Board",
    `<style>.col{border:1px solid #ccc;min-height:120px;width:200px;padding:8px}.card{background:#eef;padding:6px;margin:4px 0;cursor:grab}</style>
<div style="display:flex;gap:16px">
<section class="col" data-testid="col-todo"><h2>To do</h2><div class="card" draggable="true" data-testid="card-1" id="card-1">Write tests<span data-testid="card-1-details" hidden> · owner: QA, due Friday</span></div></section>
<section class="col" data-testid="col-doing"><h2>In progress</h2></section>
<section class="col" data-testid="col-done"><h2>Done</h2></section></div>
<p>Done: <span data-testid="done-count">0</span></p>
<h2>History</h2><ul data-testid="history" id="history"></ul><div id="more" style="height:20px"></div>
<script>const card=document.getElementById("card-1"),details=card.querySelector("span");
card.onmouseenter=()=>{details.hidden=false;};card.onmouseleave=()=>{details.hidden=true;};
card.ondragstart=(e)=>{e.dataTransfer.setData("text/plain","card-1");};
for(const col of document.querySelectorAll(".col")){col.ondragover=(e)=>e.preventDefault();
col.ondrop=(e)=>{e.preventDefault();let target=col;
if(col.dataset.testid==="col-done"&&window.__BUGS.BUG_DRAG_WRONG_COLUMN)target=document.querySelector("[data-testid=col-doing]");
target.appendChild(card);document.querySelector("[data-testid=done-count]").textContent=String(document.querySelectorAll("[data-testid=col-done] .card").length);};}
let page=0,loading=false;const ul=document.getElementById("history");
const load=async()=>{if(loading||page>=5)return;loading=true;const items=await (await fetch("/board/history?page="+page)).json();page+=1;
for(const h of items){const li=document.createElement("li");li.dataset.testid="history-"+h.id;li.textContent=h.id+": "+h.text;li.style.height="40px";ul.appendChild(li);}loading=false;
const more=document.getElementById("more");observer.unobserve(more);observer.observe(more);};
const observer=new IntersectionObserver((es)=>{if(es.some((x)=>x.isIntersecting))load();});observer.observe(document.getElementById("more"));</script>`,
  ],
  "/app/reviews": [
    "Reviews",
    `<qj-rating data-testid="rating"></qj-rating>
<p>Your rating: <span data-testid="rating-value">none</span></p>
<canvas data-testid="ratings-chart" width="300" height="120"></canvas>
<p>Legacy widget: <qj-legacy data-testid="legacy" id="legacy"></qj-legacy></p>
<script>const counts=[1,0,2,5,3];
const draw=()=>{const c=document.querySelector("[data-testid=ratings-chart]").getContext("2d");c.clearRect(0,0,300,120);
counts.forEach((n,i)=>{c.fillStyle="#2f6fde";c.fillRect(10+i*58,110-n*15,40,n*15);});};
window.__QA_STATE__=()=>({bars:counts.map((value,i)=>({stars:i+1,value}))});
customElements.define("qj-rating",class extends HTMLElement{connectedCallback(){const root=this.attachShadow({mode:"open"});
for(let i=1;i<=5;i++){const b=document.createElement("button");b.textContent="★";b.setAttribute("data-testid","star-"+i);b.setAttribute("aria-label",i+" stars");
b.onclick=()=>{const v=window.__BUGS.BUG_RATING_OFF_BY_ONE?i-1:i;document.querySelector("[data-testid=rating-value]").textContent=v+" / 5";counts[v-1]+=1;draw();};root.appendChild(b);}}});
customElements.define("qj-legacy",class extends HTMLElement{connectedCallback(){const root=this.attachShadow({mode:"closed"});
const b=document.createElement("button");b.textContent="Reveal";b.setAttribute("data-testid","reveal");root.appendChild(b);}});
draw();</script>`,
  ],
  "/app/login": [
    "Log in",
    `<form id="f"><label>User <input name="username" data-testid="username"></label>
<label>Password <input name="password" type="password" data-testid="password"></label>
<button type="submit" data-testid="login">Log in</button></form>
<script>document.getElementById("f").onsubmit=async(e)=>{e.preventDefault();const d=new FormData(e.target);
const r=await fetch("/auth/login",{method:"POST",body:JSON.stringify({username:d.get("username"),password:d.get("password")})});
if(r.ok){sessionStorage.setItem("token",(await r.json()).token);location.href="/app/products";}else toast("Invalid credentials",false);};</script>`,
  ],
  "/app/products": [
    "Products",
    `<ul id="list"></ul>
<script>(async()=>{const items=await (await fetch("/products")).json();const ul=document.getElementById("list");
for(const p of items){const li=document.createElement("li");li.dataset.testid="product-"+p.id;
li.innerHTML='<span class="name"></span> <span data-testid="price-'+p.id+'"></span> <button data-testid="add-'+p.id+'">Add to cart</button>';
li.querySelector(".name").textContent=p.name;li.querySelector("[data-testid^=price]").textContent=price(p.price);
li.querySelector("button").onclick=async()=>{const r=await api("/cart/lines",{method:"POST",body:JSON.stringify({product_id:p.id,quantity:1})});toast(r.ok?"Added "+p.name:"Could not add",r.ok);};
ul.appendChild(li);}
document.getElementById("export").onclick=()=>{const rows=items.map((p)=>p.id+","+p.name+","+p.price);
if(window.__BUGS.BUG_EXPORT_DROPS_LAST_ROW)rows.pop();
const a=document.createElement("a");a.href=URL.createObjectURL(new Blob(["id,name,price\\n"+rows.join("\\n")+"\\n"],{type:"text/csv"}));a.download="products.csv";document.body.appendChild(a);a.click();a.remove();};})();</script>
<button data-testid="export-csv" id="export">Export CSV</button>`,
  ],
  "/app/cart": [
    "Cart",
    `<ul id="lines"></ul><p>Total: <span data-testid="cart-total"></span></p>
<script>(async()=>{const r=await api("/cart");if(!r.ok){toast("Please log in",false);return;}const c=await r.json();
const ul=document.getElementById("lines");for(const l of c.lines){const li=document.createElement("li");li.dataset.testid="line-"+l.product_id;li.textContent=l.product_id+" × "+l.quantity+" = "+price(l.line_total);ul.appendChild(li);}
document.querySelector("[data-testid=cart-total]").textContent=price(c.total);})();</script>`,
  ],
  "/app/checkout": [
    "Checkout",
    `<label><input type="checkbox" data-testid="accept-terms" id="terms"> I accept the terms</label>
<button data-testid="place-order" id="place" disabled>Place order</button>
<script>const terms=document.getElementById("terms"),place=document.getElementById("place");
terms.onchange=()=>{if(!window.__BUGS.BUG_CHECKOUT_BUTTON_DISABLED)place.disabled=!terms.checked;};
place.onclick=async()=>{const r=await api("/checkout",{method:"POST",body:JSON.stringify({accept_terms:terms.checked})});
if(r.ok||window.__BUGS.BUG_SILENT_500_TOAST){toast("Order placed",true);}else{toast("Order failed",false);}};</script>`,
  ],
};

const WIDGETS = {
  "/widget/pay": `<!doctype html><html><head><meta charset="utf-8"><title>Pay</title></head><body style="font:14px system-ui">
<label>Card number <input data-testid="card-number" id="card"></label>
<button data-testid="pay" id="pay">Pay</button> <span data-testid="widget-status"></span>
<script>document.getElementById("pay").onclick=()=>{if(!/^\\d{16}$/.test(document.getElementById("card").value)){document.querySelector("[data-testid=widget-status]").textContent="Invalid card";return;}
window.open("/widget/3ds","threeds","width=420,height=260");};
window.addEventListener("message",(e)=>{if(e.origin!==location.origin||!e.data||e.data.type!=="3ds-ok")return;
document.querySelector("[data-testid=widget-status]").textContent="Confirmed";window.parent.postMessage({type:"paid"},location.origin);});</script></body></html>`,
  "/widget/3ds": `<!doctype html><html><head><meta charset="utf-8"><title>3-D Secure</title></head><body style="font:14px system-ui">
<h1>Confirm the payment</h1><button data-testid="confirm-3ds" id="ok">Confirm</button> <span data-testid="3ds-done"></span>
<script>document.getElementById("ok").onclick=()=>{window.opener.postMessage({type:"3ds-ok"},location.origin);
document.querySelector("[data-testid=3ds-done]").textContent="Confirmed, you can close this window";};</script></body></html>`,
};

/**
 * Serves a UI page, or returns false when the path is not a UI page.
 *
 * @param {string} pathname
 * @param {Record<string, boolean>} bugs
 * @param {import("node:http").ServerResponse} res
 */
export function serveWeb(pathname, bugs, res) {
  // The payment provider's widget and its 3-D Secure window: bare pages without the shop's navigation.
  const widget = WIDGETS[pathname];
  if (widget) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(widget);
    return true;
  }
  const entry = PAGES[pathname === "/" || pathname === "/app" ? "/app/products" : pathname];
  if (!entry) return false;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page(entry[0], entry[1], bugs));
  return true;
}
