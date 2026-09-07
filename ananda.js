const cats=[
["1. Men's Wellness","images/cat-1.jpg","Men's general wellness, vitality, healthy routines and lifestyle support."],
["2. Women's Wellness","images/cat-2.jpg","Women's wellness, balance, lifestyle and natural self-care."],
["3. Bones, Joints & Mobility","images/cat-3.jpg","Lifestyle and wellness information supporting comfortable movement and mobility."],
["4. Urinary & Excretory Wellness","images/cat-4.jpg","General wellness education around hydration, lifestyle and urinary health."],
["5. Skin & Natural Cleansing","images/cat-5.jpg","Natural skin care, cleansing and healthy lifestyle principles."],
["6. Digestive & Gut Wellness","images/cat-6.jpg","Digestive wellness, balanced routines and healthy gut habits."],
["7. Nervous System & Mind Wellness","images/cat-7.jpg","Mind-body wellbeing, relaxation, mindfulness and healthy routines."],
["8. Heart & Circulatory Wellness","images/cat-8.jpg","Lifestyle education supporting cardiovascular and circulatory wellbeing."],
["9. Respiratory Wellness","images/cat-9.jpg","Breathing, lifestyle and general respiratory wellness education."],
["10. Mental Wellness & Stress Management","images/cat-10.jpg","Mindfulness, relaxation, breathing and practical stress-management habits."]
];
const products=[
["Triphala Digestive Blend","KES 3,200","images/cat-6.jpg","A traditional Ayurvedic-inspired blend for digestive wellness.","Supports healthy digestion and balanced routines."],
["Turmeric Golden Blend","KES 3,000","images/cat-5.jpg","A warming herbal wellness blend inspired by traditional knowledge.","Suitable for a balanced natural wellness routine."],
["Shatavari Vitality Powder","KES 3,500","images/cat-2.jpg","Traditional herbal powder for general vitality and wellbeing.","Use according to product directions or practitioner guidance."],
["Daily Balance Blend","KES 2,900","herbal-hero.jpg","An everyday herbal wellness blend.","Designed to complement healthy lifestyle practices."]
];
let cart=JSON.parse(localStorage.getItem('anandaCart')||'[]');

function show(id){
 document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
 const el=document.getElementById(id); if(el) el.classList.add('active');
 const base=['home','shop','consult','learn','contact'].includes(id)?id:(id==='categories'||id==='programmes'||id==='drkim'||id==='hub'||id==='blog'||id==='testimonials'||id==='categoryDetail'? 'learn':id==='product'||id==='cart'||id==='checkout'?'shop':id);
 document.querySelectorAll('.navbtn').forEach(b=>b.classList.toggle('active',b.dataset.page===base));
 window.scrollTo(0,0);
 if(id==='shop')renderProducts(); if(id==='cart')renderCart();
}
function renderProducts(){
 const q=(document.getElementById('search')?.value||'').toLowerCase();
 const list=products.filter(p=>p[0].toLowerCase().includes(q));
 document.getElementById('products').innerHTML=list.map((p,i)=>productCard(p,i)).join('');
}
function productCard(p,i){return `<div class="card product"><img src="${p[2]}"><h3>${p[0]}</h3><p>${p[3]}</p><div class="price">${p[1]}</div><button class="smallbtn" onclick="details(${i})">VIEW DETAILS</button></div>`}
function details(i){const p=products[i];document.getElementById('productDetail').innerHTML=`<img class="detailimg" src="${p[2]}"><h1 class="title">${p[0]}</h1><div class="price">${p[1]}</div><p class="intro">${p[3]}</p><div class="card"><h3>Benefits</h3><p>${p[4]}</p></div><div class="card"><h3>How to use</h3><p>Follow the product label or personalised guidance from your wellness practitioner. Do not exceed recommended use.</p></div><button class="btn green" style="width:100%" onclick="addCart(${i})">ADD TO CART</button>`;show('product')}
function addCart(i){cart.push(i);localStorage.setItem('anandaCart',JSON.stringify(cart));show('cart')}
function renderCart(){
 const box=document.getElementById('cartItems');
 if(!cart.length){
   box.innerHTML='<div class="card"><p>Your cart is empty.</p></div>';
   document.getElementById('subtotal').textContent='KES 0';
   document.getElementById('total').textContent='KES 0';
   return;
 }
 let total=0;
 box.innerHTML=cart.map((idx,n)=>{
   const p=products[idx];
   const amount=parseInt(p[1].replace(/[^0-9]/g,''));
   total+=amount;
   return `<div class="card listrow">
     <img src="${p[2]}" style="width:60px;height:60px;object-fit:cover;border-radius:8px">
     <div><b>${p[0]}</b><div class="price">${p[1]}</div></div>
     <button style="margin-left:auto;border:0;background:none" onclick="removeCart(${n})">🗑</button>
   </div>`;
 }).join('');
 document.getElementById('subtotal').textContent='KES '+total.toLocaleString();
 document.getElementById('total').textContent='KES '+total.toLocaleString();
}
function removeCart(n){cart.splice(n,1);localStorage.setItem('anandaCart',JSON.stringify(cart));renderCart()}
function placeOrder(){const name=document.getElementById('custName').value.trim(),phone=document.getElementById('custPhone').value.trim(),address=document.getElementById('custAddress').value.trim(),city=document.getElementById('custCity').value.trim(),code=document.getElementById('mpesaCode').value.trim(),paid=document.getElementById('paid').checked;if(!name||!phone||!address||!city||!code||!paid){alert('Please complete your details, enter the M-PESA confirmation code and confirm that you paid Till 5475967 before placing the order.');return}localStorage.removeItem('anandaCart');cart=[];alert('Order received. Payment confirmation recorded. Delivery can now be arranged.');show('home')}
function bookConsult(){const n=document.getElementById('conName').value.trim(),p=document.getElementById('conPhone').value.trim();if(!n||!p){alert('Please enter your name and phone number.');return}localStorage.setItem('anandaConsultation',JSON.stringify({name:n,phone:p,email:document.getElementById('conEmail').value,type:document.getElementById('conType').value,date:document.getElementById('conDate').value,time:document.getElementById('conTime').value,reason:document.getElementById('conReason').value}));show('consultDone')}
function renderCats(){document.getElementById('categoriesGrid').innerHTML=cats.map((c,i)=>`<div class="card category" onclick="openCat(${i})"><img src="${c[1]}"><div class="ct"><h3>${c[0]}</h3></div></div>`).join('')}
function openCat(i){const c=cats[i];document.getElementById('categoryContent').innerHTML=`<img class="detailimg" src="${c[1]}"><div class="eyebrow">WELLNESS CATEGORY</div><h1 class="title">${c[0]}</h1><p class="intro">${c[2]}</p><div class="card"><h3>Explore this area</h3><p>Learn about lifestyle practices, traditional wellness approaches and related ANANDA products. Information provided is for general wellness education and is not a substitute for medical diagnosis or treatment.</p></div><button class="btn green" style="width:100%" onclick="show('shop')">VIEW WELLNESS SHOP</button>`;show('categoryDetail')}
renderCats();renderProducts();document.getElementById('homeProducts').innerHTML=products.slice(0,4).map((p,i)=>productCard(p,i)).join('');
