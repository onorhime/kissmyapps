/** No .env loading. Secrets enter only through the process environment. */
export function realTestOptions(env=process.env){
 if(env.KMA_REAL_TEST_ENABLED!=='true')throw Error('Set KMA_REAL_TEST_ENABLED=true to opt into the real Stripe TEST environment.')
 const key=env.KMA_REAL_TEST_STRIPE_SECRET_KEY??''
 if(!/^(sk|rk)_test_[A-Za-z0-9]{12,}$/.test(key))throw Error('A Stripe TEST secret/restricted key is required. Live and publishable keys are refused.')
 const accountId=env.KMA_REAL_TEST_STRIPE_ACCOUNT_ID??'',priceId=env.KMA_REAL_TEST_STRIPE_PRICE_ID??''
 if(!/^acct_[A-Za-z0-9]+$/.test(accountId)||!/^price_[A-Za-z0-9_]{8,128}$/.test(priceId))throw Error('Supply the verified test Stripe account ID and one-time USD $169 Price ID.')
 const webhookSecret=env.KMA_REAL_TEST_WEBHOOK_SECRET??''
 if(webhookSecret&&!/^whsec_[A-Za-z0-9]+$/.test(webhookSecret))throw Error('The local forwarding webhook secret is invalid.')
 return {key,accountId,priceId,webhookSecret}
}
export function localOrigin(value){const u=new URL(value);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('Only a loopback HTTP origin is allowed.');return u.origin}
export function realStripeTestTransport(key,fetcher=fetch){
 if(!/^(sk|rk)_test_[A-Za-z0-9]{12,}$/.test(key))throw Error('Refusing non-test Stripe credentials.')
 return async(input,init={})=>{
  const u=new URL(String(input)),headers=new Headers(init.headers),method=init.method??'GET';
  if(u.origin!=='https://api.stripe.com'||u.username||u.password||u.hash||!u.pathname.startsWith('/v1/')||headers.get('authorization')!==`Bearer ${key}`||init.redirect!=='error')throw Error('Provider request outside guarded test transport.')
  if(!['GET','POST'].includes(method)||method==='POST'&&!(/^\/v1\/checkout\/sessions(?:\/cs_[A-Za-z0-9_]+\/expire)?$/.test(u.pathname)||u.pathname==='/v1/refunds'))throw Error('This rehearsal cannot create products, prices, accounts, transfers, payouts or unrelated provider objects.')
  return fetcher(u,init)
 }
}
