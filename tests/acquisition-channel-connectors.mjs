import assert from "node:assert/strict";
import {
  buildWecomEncryptedReply,
  buildWecomTextReply,
  clearWecomAccessTokenCache,
  decryptWecomMessage,
  douyinSignature,
  encryptWecomMessage,
  handleDouyinWebhook,
  handleWecomWebhook,
  parseWecomXml,
  verifyWecomSignature,
  wecomSignature
} from "../server/acquisition-channel-connectors.mjs";

const encodingAesKey = Buffer.from(Array.from({ length:32 }, (_, index) => index))
  .toString("base64")
  .replace(/=$/, "");
const wecomEnv = {
  HUAMEI_CHANNEL_WECOM_CORP_ID:"ww-test-corp",
  HUAMEI_CHANNEL_WECOM_AGENT_ID:"1000002",
  HUAMEI_CHANNEL_WECOM_SECRET:"test-secret",
  HUAMEI_CHANNEL_WECOM_TOKEN:"test-token",
  HUAMEI_CHANNEL_WECOM_ENCODING_AES_KEY:encodingAesKey,
  HUAMEI_CHANNEL_WECOM_TENANT_ID:"tenant-channel",
  HUAMEI_CHANNEL_WECOM_REPLY_MODE:"passive"
};

const encryptedRoundTrip = encryptWecomMessage(
  "<xml><Content><![CDATA[热玛吉的一般原理]]></Content></xml>",
  encodingAesKey,
  wecomEnv.HUAMEI_CHANNEL_WECOM_CORP_ID
);
const decryptedRoundTrip = decryptWecomMessage(encryptedRoundTrip, encodingAesKey);
assert.equal(decryptedRoundTrip.receive_id, wecomEnv.HUAMEI_CHANNEL_WECOM_CORP_ID);
assert.match(decryptedRoundTrip.message, /热玛吉的一般原理/);
assert.equal(parseWecomXml(decryptedRoundTrip.message).Content, "热玛吉的一般原理");

const signatureInput = {
  token:wecomEnv.HUAMEI_CHANNEL_WECOM_TOKEN,
  timestamp:"1760000000",
  nonce:"nonce-wecom",
  encrypted:encryptedRoundTrip
};
const signature = wecomSignature(signatureInput);
assert.match(signature, /^[a-f0-9]{40}$/);
assert.equal(verifyWecomSignature(signatureInput, signature), true);
assert.equal(verifyWecomSignature({ ...signatureInput, nonce:"tampered" }, signature), false);

const echo = encryptWecomMessage("wecom-verification-ok", encodingAesKey, wecomEnv.HUAMEI_CHANNEL_WECOM_CORP_ID);
const echoTimestamp = "1760000100";
const echoNonce = "echo-nonce";
const echoSignature = wecomSignature({
  token:wecomEnv.HUAMEI_CHANNEL_WECOM_TOKEN,
  timestamp:echoTimestamp,
  nonce:echoNonce,
  encrypted:echo
});
const verification = await handleWecomWebhook({
  method:"GET",
  url:new URL(`http://local/v1/channels/wecom/webhook?msg_signature=${echoSignature}&timestamp=${echoTimestamp}&nonce=${echoNonce}&echostr=${encodeURIComponent(echo)}`),
  env:wecomEnv,
  now:Number(echoTimestamp) * 1_000,
  processEnvelope:async () => { throw new Error("GET不应调用智能体"); }
});
assert.equal(verification.status, 200);
assert.equal(verification.body, "wecom-verification-ok");

const inboundXml = [
  "<xml>",
  "<ToUserName><![CDATA[ww-test-corp]]></ToUserName>",
  "<FromUserName><![CDATA[zhangsan]]></FromUserName>",
  "<CreateTime>1760000200</CreateTime>",
  "<MsgType><![CDATA[text]]></MsgType>",
  "<Content><![CDATA[我想了解热玛吉]]></Content>",
  "<MsgId>90001</MsgId>",
  "<AgentID>1000002</AgentID>",
  "</xml>"
].join("");
const inboundEncrypted = encryptWecomMessage(inboundXml, encodingAesKey, wecomEnv.HUAMEI_CHANNEL_WECOM_CORP_ID);
const inboundTimestamp = "1760000200";
const inboundNonce = "message-nonce";
const inboundSignature = wecomSignature({
  token:wecomEnv.HUAMEI_CHANNEL_WECOM_TOKEN,
  timestamp:inboundTimestamp,
  nonce:inboundNonce,
  encrypted:inboundEncrypted
});
let processedEnvelope;
const reply = await handleWecomWebhook({
  method:"POST",
  url:new URL(`http://local/v1/channels/wecom/webhook?msg_signature=${inboundSignature}&timestamp=${inboundTimestamp}&nonce=${inboundNonce}`),
  rawBody:`<xml><Encrypt><![CDATA[${inboundEncrypted}]]></Encrypt></xml>`,
  env:wecomEnv,
  requestId:"req-wecom-1",
  now:Number(inboundTimestamp) * 1_000,
  processEnvelope:async (envelope) => {
    processedEnvelope = envelope;
    return {
      request_id:"req-wecom-1",
      tenant_id:envelope.tenant_id,
      channel:"wecom",
      conversation_id:envelope.conversation_id,
      run_id:"run_wecom_1",
      status:"completed",
      reply:{ text:"您好，热玛吉一般通过射频能量作用于皮肤组织。", segments:["您好，热玛吉一般通过射频能量作用于皮肤组织。"] },
      delivery:{ suppress_ai:false }
    };
  }
});
assert.equal(processedEnvelope.tenant_id, "tenant-channel");
assert.equal(processedEnvelope.actor.external_user_id, "zhangsan");
assert.equal(processedEnvelope.message.id, "90001");
const outerReply = parseWecomXml(reply.body);
assert.equal(verifyWecomSignature({
  token:wecomEnv.HUAMEI_CHANNEL_WECOM_TOKEN,
  timestamp:String(outerReply.TimeStamp),
  nonce:outerReply.Nonce,
  encrypted:outerReply.Encrypt
}, outerReply.MsgSignature), true);
const decryptedReply = decryptWecomMessage(outerReply.Encrypt, encodingAesKey);
assert.equal(decryptedReply.receive_id, wecomEnv.HUAMEI_CHANNEL_WECOM_CORP_ID);
const parsedReply = parseWecomXml(decryptedReply.message);
assert.equal(parsedReply.ToUserName, "zhangsan");
assert.match(parsedReply.Content, /热玛吉/);

const suppression = await handleWecomWebhook({
  method:"POST",
  url:new URL(`http://local/v1/channels/wecom/webhook?msg_signature=${inboundSignature}&timestamp=${inboundTimestamp}&nonce=${inboundNonce}`),
  rawBody:`<xml><Encrypt><![CDATA[${inboundEncrypted}]]></Encrypt></xml>`,
  env:wecomEnv,
  requestId:"req-wecom-2",
  now:Number(inboundTimestamp) * 1_000,
  processEnvelope:async (envelope) => ({
    tenant_id:envelope.tenant_id,
    channel:"wecom",
    conversation_id:envelope.conversation_id,
    run_id:"run_wecom_2",
    status:"handover_required",
    reply:{ text:"不应发送" },
    delivery:{ suppress_ai:true }
  })
});
assert.equal(suppression.body, "success");
assert.equal(suppression.audit.outcome, "handover_suppressed");

clearWecomAccessTokenCache();
const activeRequests = [];
const activeReply = await handleWecomWebhook({
  method:"POST",
  url:new URL(`http://local/v1/channels/wecom/webhook?msg_signature=${inboundSignature}&timestamp=${inboundTimestamp}&nonce=${inboundNonce}`),
  rawBody:`<xml><Encrypt><![CDATA[${inboundEncrypted}]]></Encrypt></xml>`,
  env:{ ...wecomEnv, HUAMEI_CHANNEL_WECOM_REPLY_MODE:"active" },
  requestId:"req-wecom-active",
  now:Number(inboundTimestamp) * 1_000,
  processEnvelope:async (envelope) => ({
    request_id:"req-wecom-active",
    tenant_id:envelope.tenant_id,
    channel:"wecom",
    conversation_id:envelope.conversation_id,
    run_id:"run_wecom_active",
    status:"completed",
    reply:{ text:"主动消息回复", segments:["主动消息回复"] },
    delivery:{ suppress_ai:false }
  }),
  fetchImpl:async (url, options) => {
    activeRequests.push({ url:String(url), options });
    if (String(url).includes("/cgi-bin/gettoken")) {
      return new Response(JSON.stringify({ errcode:0, access_token:"test-access-token", expires_in:7200 }), {
        status:200,
        headers:{ "Content-Type":"application/json" }
      });
    }
    return new Response(JSON.stringify({ errcode:0, errmsg:"ok", msgid:"wecom-out-1" }), {
      status:200,
      headers:{ "Content-Type":"application/json" }
    });
  }
});
assert.equal(activeReply.body, "success");
assert.equal(activeReply.audit.outcome, "active_send");
assert.equal(activeReply.audit.delivery.delivered, true);
assert.equal(activeReply.audit.delivery.external_message_id, "wecom-out-1");
assert.equal(activeRequests.length, 2);
assert.match(activeRequests[0].url, /corpid=ww-test-corp/);
assert.equal(JSON.parse(activeRequests[1].options.body).touser, "zhangsan");

const passiveXml = buildWecomTextReply({ toUser:"customer", fromUser:"corp", content:"回复" });
const passiveEnvelope = buildWecomEncryptedReply({
  plaintextXml:passiveXml,
  token:wecomEnv.HUAMEI_CHANNEL_WECOM_TOKEN,
  encodingAesKey,
  receiveId:wecomEnv.HUAMEI_CHANNEL_WECOM_CORP_ID,
  timestamp:1760000300,
  nonce:"reply-nonce"
});
assert.match(passiveEnvelope, /<MsgSignature>/);

const douyinEnv = {
  HUAMEI_CHANNEL_DOUYIN_APP_ID:"douyin-app",
  HUAMEI_CHANNEL_DOUYIN_APP_SECRET:"douyin-secret",
  HUAMEI_CHANNEL_DOUYIN_WEBHOOK_SECRET:"douyin-webhook-secret",
  HUAMEI_CHANNEL_DOUYIN_VERIFY_TOKEN:"douyin-verify-token",
  HUAMEI_CHANNEL_DOUYIN_REPLY_WEBHOOK_URL:"https://connector.example.test/douyin/reply",
  HUAMEI_CHANNEL_DOUYIN_REPLY_TOKEN:"connector-token",
  HUAMEI_CHANNEL_DOUYIN_TENANT_ID:"tenant-douyin"
};
const douyinRawBody = JSON.stringify({
  event_id:"dy-event-1",
  conversation_id:"dy-thread-1",
  open_id:"dy-user-1",
  text:"隆鼻需要了解什么",
  event_type:"im_message"
});
const douyinTime = 1770000000;
const douyinNonce = "douyin-nonce";
const douyinHeaderSignature = douyinSignature({
  secret:douyinEnv.HUAMEI_CHANNEL_DOUYIN_WEBHOOK_SECRET,
  timestamp:String(douyinTime),
  nonce:douyinNonce,
  rawBody:douyinRawBody
});
let relayPayload;
const douyinReply = await handleDouyinWebhook({
  method:"POST",
  url:new URL("http://local/v1/channels/douyin/webhook"),
  headers:{
    "x-huamei-timestamp":String(douyinTime),
    "x-huamei-nonce":douyinNonce,
    "x-huamei-signature":douyinHeaderSignature
  },
  rawBody:douyinRawBody,
  env:douyinEnv,
  requestId:"req-douyin-1",
  now:douyinTime * 1_000,
  processEnvelope:async (envelope) => ({
    request_id:"req-douyin-1",
    tenant_id:envelope.tenant_id,
    channel:"douyin",
    conversation_id:envelope.conversation_id,
    run_id:"run_douyin_1",
    status:"completed",
    reply:{ text:"可以先说说您的关注点和期望效果。", segments:["可以先说说您的关注点和期望效果。"] },
    delivery:{ suppress_ai:false }
  }),
  fetchImpl:async (url, options) => {
    relayPayload = { url, body:JSON.parse(options.body), headers:options.headers };
    return new Response(JSON.stringify({ delivered:true, message_id:"dy-out-1" }), {
      status:200,
      headers:{ "Content-Type":"application/json" }
    });
  }
});
assert.equal(douyinReply.status, 202);
assert.equal(douyinReply.body.status, "delivered");
assert.equal(relayPayload.body.recipient.open_id, "dy-user-1");
assert.equal(relayPayload.body.conversation_id, "dy-thread-1");
assert.match(relayPayload.body.reply.text, /关注点/);
assert.equal(relayPayload.headers["Idempotency-Key"], "dy-event-1");

console.log("✓ 企业微信签名/AES回调、防止人工接管抢答及抖音签名中转通过");
