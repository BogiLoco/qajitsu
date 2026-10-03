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
ul.appendChild(li);}})();</script>`,
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

/**
 * Serves a UI page, or returns false when the path is not a UI page.
 *
 * @param {string} pathname
 * @param {Record<string, boolean>} bugs
 * @param {import("node:http").ServerResponse} res
 */
export function serveWeb(pathname, bugs, res) {
  const entry = PAGES[pathname === "/" || pathname === "/app" ? "/app/products" : pathname];
  if (!entry) return false;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page(entry[0], entry[1], bugs));
  return true;
}
