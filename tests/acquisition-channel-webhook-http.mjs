import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const encodingAesKey = Buffer.from(Array.from({ length:32 }, (_, index) => index + 1))
  .toString("base64")
  .replace(/=$/, "");
const wecomCorpId = "ww-webhook-http-test";
const wecomToken = "wecom-http-token";
const douyinSecret = "douyin-http-secret";

Object.assign(process.env, {
  NODE_ENV:"test",
  HUAMEI_PERSISTENCE_BACKEND:"local_json",
  HUAMEI_DATABASE_URL:"",
  HUAMEI_CACHE_BACKEND:"memory",
  HUAMEI_LLM_ENABLED:"false",
  HUAMEI_GRAPHRAG_ENABLED:"false",
  HUAMEI_ACQUISITION_SESSION_STORE_FILE:":memory:",
  HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE:":memory:",
  HUAMEI_CONVERSATION_FEEDBACK_STORE_FILE:":memory:",
  HUAMEI_KNOWLEDGE_RELEASE_STORE_FILE:":memory:",
  HUAMEI_LEAD_STORE_FILE:":memory:",
  HUAMEI_CHANNEL_WECOM_CORP_ID:wecomCorpId,
  HUAMEI_CHANNEL_WECOM_AGENT_ID:"1000002",
  HUAMEI_CHANNEL_WECOM_SECRET:"wecom-http-secret",
  HUAMEI_CHANNEL_WECOM_TOKEN:wecomToken,
  HUAMEI_CHANNEL_WECOM_ENCODING_AES_KEY:encodingAesKey,
  HUAMEI_CHANNEL_WECOM_TENANT_ID:"tenant-wecom-http",
  HUAMEI_CHANNEL_WECOM_REPLY_MODE:"passive",
  HUAMEI_CHANNEL_DOUYIN_APP_ID:"douyin-http-app",
  HUAMEI_CHANNEL_DOUYIN_APP_SECRET:"douyin-http-secret",
  HUAMEI_CHANNEL_DOUYIN_WEBHOOK_SECRET:douyinSecret,
  HUAMEI_CHANNEL_DOUYIN_VERIFY_TOKEN:"douyin-http-verify",
  HUAMEI_CHANNEL_DOUYIN_TENANT_ID:"tenant-douyin-http",
  HUAMEI_CHANNEL_DOUYIN_REPLY_WEBHOOK_URL:"https://connector.example.test/reply",
  HUAMEI_CHANNEL_DOUYIN_REPLY_TOKEN:"douyin-http-reply-token"
});

const {
  douyinSignature,
  encryptWecomMessage,
  parseWecomXml,
  wecomSignature
} = await import("../server/acquisition-channel-connectors.mjs");
const { createAcquisitionServiceServer } = await import("../server/acquisition-service-server.mjs");

const processed = [];
const server = createAcquisitionServiceServer({
  host:"127.0.0.1",
  channelWebhookProcessEnvelope:async (envelope) => {
    processed.push(envelope);
    return {
      request_id:`request-${envelope.channel}`,
      tenant_id:envelope.tenant_id,
      channel:envelope.channel,
      conversation_id:envelope.conversation_id,
      run_id:`run_${envelope.channel}_http`,
      status:"completed",
      reply:{
        text:`${envelope.channel} 模拟回复`,
        segments:[`${envelope.channel} 模拟回复`]
      },
      delivery:{ suppress_ai:false }
    };
  },
  channelFetch:async (url) => {
    assert.match(String(url), /connector\.example\.test\/reply/);
    return new Response(JSON.stringify({ delivered:true, message_id:"dy-http-out-1" }), {
      status:200,
      headers:{ "Content-Type":"application/json" }
    });
  }
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

try {
  const channels = await fetch(`${baseUrl}/v1/channels`);
  assert.equal(channels.status, 200);
  const channelData = (await channels.json()).data;
  assert.equal(channelData.find((item) => item.id === "wecom")?.status, "ready");
  assert.equal(channelData.find((item) => item.id === "douyin")?.status, "ready");

  const echo = encryptWecomMessage("wecom-http-echo", encodingAesKey, wecomCorpId);
  const echoTimestamp = String(Math.floor(Date.now() / 1_000));
  const echoNonce = randomBytes(6).toString("hex");
  const echoQuery = new URLSearchParams({
    msg_signature:wecomSignature({ token:wecomToken, timestamp:echoTimestamp, nonce:echoNonce, encrypted:echo }),
    timestamp:echoTimestamp,
    nonce:echoNonce,
    echostr:echo
  });
  const verification = await fetch(`${baseUrl}/v1/channels/wecom/webhook?${echoQuery}`);
  assert.equal(verification.status, 200);
  assert.equal(await verification.text(), "wecom-http-echo");

  const inboundXml = [
    "<xml>",
    `<ToUserName>${wecomCorpId}</ToUserName>`,
    "<FromUserName>webhook-http-user</FromUserName>",
    `<CreateTime>${echoTimestamp}</CreateTime>`,
    "<MsgType>text</MsgType>",
    "<Content>我想了解光子嫩肤</Content>",
    "<MsgId>wecom-http-msg-1</MsgId>",
    "</xml>"
  ].join("");
  const inboundEncrypted = encryptWecomMessage(inboundXml, encodingAesKey, wecomCorpId);
  const messageNonce = randomBytes(6).toString("hex");
  const messageQuery = new URLSearchParams({
    msg_signature:wecomSignature({
      token:wecomToken,
      timestamp:echoTimestamp,
      nonce:messageNonce,
      encrypted:inboundEncrypted
    }),
    timestamp:echoTimestamp,
    nonce:messageNonce
  });
  const wecomResponse = await fetch(`${baseUrl}/v1/channels/wecom/webhook?${messageQuery}`, {
    method:"POST",
    headers:{ "Content-Type":"application/xml" },
    body:`<xml><Encrypt>${inboundEncrypted}</Encrypt></xml>`
  });
  assert.equal(wecomResponse.status, 200);
  const wecomReply = parseWecomXml(await wecomResponse.text());
  assert.ok(wecomReply.Encrypt);

  const douyinBody = JSON.stringify({
    event_id:"douyin-http-event-1",
    conversation_id:"douyin-http-thread-1",
    open_id:"douyin-http-user-1",
    text:"想咨询隆鼻",
    event_type:"im_message"
  });
  const douyinTimestamp = String(Math.floor(Date.now() / 1_000));
  const douyinNonce = "douyin-http-nonce";
  const douyinResponse = await fetch(`${baseUrl}/v1/channels/douyin/webhook`, {
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "X-Huamei-Timestamp":douyinTimestamp,
      "X-Huamei-Nonce":douyinNonce,
      "X-Huamei-Signature":douyinSignature({
        secret:douyinSecret,
        timestamp:douyinTimestamp,
        nonce:douyinNonce,
        rawBody:douyinBody
      })
    },
    body:douyinBody
  });
  assert.equal(douyinResponse.status, 202);
  const douyinReply = await douyinResponse.json();
  assert.equal(douyinReply.status, "delivered");
  assert.equal(douyinReply.delivery.external_message_id, "dy-http-out-1");
  assert.equal(processed.length, 2);
  assert.deepEqual(processed.map((item) => item.tenant_id).sort(), ["tenant-douyin-http", "tenant-wecom-http"]);

  console.log("✓ 企业微信与抖音公开回调HTTP路由、租户绑定和回复链路通过");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
