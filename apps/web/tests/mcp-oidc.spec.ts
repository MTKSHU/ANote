import {test,expect} from "@playwright/test";
import {randomUUID} from "node:crypto";
import {api,admin} from "./helpers";
import {origin,register,authorization,connect,call} from "./mcp-helpers";
test.skip(process.env.CASDOOR_TEST!=="1","Requires isolated Casdoor mock");
test("OAuth 接入经过 Casdoor 登录后仍展示绑定的授权请求，沿用现有邮箱账户",async({page,request})=>{
  const root=await admin(request),saved=await api(request,"GET","admin/settings",undefined,root),client=await register(request,"ChatGPT Casdoor 验证"),flow=authorization(client),sub="mcp-oidc-"+randomUUID(),email=sub+"@example.test";
  try{
    await api(request,"PATCH","admin/settings",{oidc_issuer:"http://casdoor-mock:4400",oidc_client_id:"test-client",oidc_secret:"test-secret",oidc_application:"",auth_mode:"both"},root);
    await request.post("http://casdoor-mock:4400/control",{data:{sub,email,name:"Casdoor AI 用户",mode:"normal"}});
    await page.route("http://127.0.0.1:33418/callback**",route=>route.fulfill({body:"OAuth returned"}));
    await page.goto(flow.url);await page.getByRole("link",{name:"使用 Casdoor 统一登录"}).click();
    const consent=page.getByRole("dialog",{name:"连接 AI 应用",exact:true});await expect(consent).toContainText("ChatGPT Casdoor 验证");await expect(consent).toContainText("Casdoor AI 用户");
    const current=await page.evaluate(()=>fetch("/api/auth/session").then(r=>r.json()));expect(current.user.email).toBe(email);expect(current.user.is_admin).toBe(false);
    const libraries=await page.evaluate(()=>fetch("/api/spaces").then(r=>r.json()));expect(libraries.filter((s:any)=>s.kind==="personal" && s.name==="默认知识库" && s.created_by===current.user.id)).toHaveLength(1);
    await consent.getByRole("button",{name:"允许连接",exact:true}).click();await expect(page).toHaveURL(/127\.0\.0\.1:33418\/callback/);const callback=new URL(page.url());expect(callback.searchParams.get("state")).toBe(flow.state);
    const response=await request.post("/token",{form:{grant_type:"authorization_code",client_id:client.client_id,code:callback.searchParams.get("code")!,code_verifier:flow.verifier,redirect_uri:client.redirect_uris[0],resource:origin+"/mcp"}});expect(response.status(),await response.text()).toBe(200);const mcp=await connect((await response.json()).access_token);try{expect((await call(mcp,"get_context")).user.id).toBe(current.user.id);}finally{await mcp.close();}
  }finally{const now=await api(request,"GET","admin/settings",undefined,root);await api(request,"PATCH","admin/settings",{...saved,revision:now.revision},root);}
});
