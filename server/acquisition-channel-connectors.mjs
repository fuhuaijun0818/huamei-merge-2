import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { formatChannelOutbound, normalizeChannelInbound } from "./acquisition-channel-adapters.mjs";
import { normalizeTenantId } from "./platform/tenant-context.mjs";

const MAX_CLOCK_SKEW_SECONDS = 300;
const DEFAULT_WECOM_API_ORIGIN = "https://qyapi.weixin.qq.com";
const wecomAccessTokenCache = new Map();

const clean = (value, maxLength = 4_096) => String(value ?? "").trim().slice(0, maxLength);
const safeEqualText = (left, right) => {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};

const connectorError = (code, message, status = 400, details = []) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
};

const requireEnvironment = (env, keys) => {
  const missing = keys.filter((key) => !clean(env?.[key]));
  if (missing.length) {
    throw connectorError(
      "CHANNEL_NOT_CONFIGURED",
      "外部渠道尚未完成配置",
      503,
      missing.map((field) => ({ field, message:"缺少渠道配置" }))
    );
  }
};

const xmlEscape = (value) => clean(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");

const cdata = (value) => `<![CDATA[${clean(value).replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;

const decodeXmlEntity = (value) => String(value || "")
  .replaceAll("&lt;", "<")
  .replaceAll("&gt;", ">")
  .replaceAll("&quot;", '"')
  .replaceAll("&apos;", "'")
  .replaceAll("&amp;", "&");

export function parseWecomXml(xmlValue) {
  const xml = clean(xmlValue, 64 * 1024);
  const parsed = {};
  const fieldPattern = /<([A-Za-z][A-Za-z0-9_-]*)>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*<\/\1>/g;
  for (const match of xml.matchAll(fieldPattern)) {
    parsed[match[1]] = decodeXmlEntity((match[2] ?? match[3] ?? "").trim());
  }
  if (!Object.keys(parsed).length) {
    throw connectorError("WECOM_XML_INVALID", "企业微信回调不是有效的XML", 400);
  }
  return parsed;
}

export function wecomSignature({ token, timestamp, nonce, encrypted }) {
  const values = [token, timestamp, nonce, encrypted].map((item) => clean(item, 64 * 1024));
  if (values.some((item) => !item)) {
    throw connectorError("WECOM_SIGNATURE_INPUT_MISSING", "企业微信验签参数不完整", 400);
  }
  return createHash("sha1").update(values.sort().join("")).digest("hex");
}

export function verifyWecomSignature(input, signature) {
  return safeEqualText(wecomSignature(input), clean(signature, 128).toLowerCase());
}

export function decodeWecomEncodingAesKey(encodingAesKey) {
  const normalized = clean(encodingAesKey, 128);
  if (normalized.length !== 43) {
    throw connectorError("WECOM_ENCODING_AES_KEY_INVALID", "企业微信EncodingAESKey必须为43位", 503);
  }
  const key = Buffer.from(`${normalized}=`, "base64");
  if (key.length !== 32) {
    throw connectorError("WECOM_ENCODING_AES_KEY_INVALID", "企业微信EncodingAESKey无法解码为32字节", 503);
  }
  return key;
}

export function decryptWecomMessage(encryptedValue, encodingAesKey) {
  const encrypted = Buffer.from(clean(encryptedValue, 64 * 1024), "base64");
  if (!encrypted.length || encrypted.length % 16 !== 0) {
    throw connectorError("WECOM_CIPHERTEXT_INVALID", "企业微信密文格式无效", 400);
  }
  const key = decodeWecomEncodingAesKey(encodingAesKey);
  let decrypted;
  try {
    const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
    decipher.setAutoPadding(false);
    decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    throw connectorError("WECOM_DECRYPT_FAILED", "企业微信消息解密失败", 400);
  }
  const padding = decrypted.at(-1);
  if (!padding || padding > 32 || padding > decrypted.length) {
    throw connectorError("WECOM_PADDING_INVALID", "企业微信消息填充无效", 400);
  }
  for (let index = decrypted.length - padding; index < decrypted.length; index += 1) {
    if (decrypted[index] !== padding) {
      throw connectorError("WECOM_PADDING_INVALID", "企业微信消息填充无效", 400);
    }
  }
  const content = decrypted.subarray(0, decrypted.length - padding);
  if (content.length < 20) {
    throw connectorError("WECOM_PAYLOAD_INVALID", "企业微信消息内容不完整", 400);
  }
  const messageLength = content.readUInt32BE(16);
  const messageEnd = 20 + messageLength;
  if (messageEnd > content.length) {
    throw connectorError("WECOM_PAYLOAD_INVALID", "企业微信消息长度无效", 400);
  }
  return {
    message: content.subarray(20, messageEnd).toString("utf8"),
    receive_id: content.subarray(messageEnd).toString("utf8")
  };
}

export function encryptWecomMessage(messageValue, encodingAesKey, receiveId) {
  const message = Buffer.from(String(messageValue || ""), "utf8");
  const random = randomBytes(16);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(message.length, 0);
  const payload = Buffer.concat([random, length, message, Buffer.from(String(receiveId || ""), "utf8")]);
  const blockSize = 32;
  const padding = blockSize - (payload.length % blockSize);
  const padded = Buffer.concat([payload, Buffer.alloc(padding, padding)]);
  const key = decodeWecomEncodingAesKey(encodingAesKey);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

export function buildWecomTextReply({ toUser, fromUser, content, timestamp = Math.floor(Date.now() / 1_000) }) {
  return [
    "<xml>",
    `<ToUserName>${cdata(toUser)}</ToUserName>`,
    `<FromUserName>${cdata(fromUser)}</FromUserName>`,
    `<CreateTime>${Number(timestamp)}</CreateTime>`,
    `<MsgType>${cdata("text")}</MsgType>`,
    `<Content>${cdata(content)}</Content>`,
    "</xml>"
  ].join("");
}

export function buildWecomEncryptedReply({
  plaintextXml,
  token,
  encodingAesKey,
  receiveId,
  timestamp = Math.floor(Date.now() / 1_000),
  nonce = randomBytes(12).toString("hex")
}) {
  const encrypted = encryptWecomMessage(plaintextXml, encodingAesKey, receiveId);
  const signature = wecomSignature({ token, timestamp, nonce, encrypted });
  return [
    "<xml>",
    `<Encrypt>${cdata(encrypted)}</Encrypt>`,
    `<MsgSignature>${cdata(signature)}</MsgSignature>`,
    `<TimeStamp>${Number(timestamp)}</TimeStamp>`,
    `<Nonce>${cdata(nonce)}</Nonce>`,
    "</xml>"
  ].join("");
}

const normalizedSignatureValue = (value) => clean(value, 256)
  .replace(/^sha256=/i, "")
  .trim();

export function douyinSignature({ secret, timestamp, nonce, rawBody }) {
  return createHmac("sha256", clean(secret))
    .update(`${clean(timestamp, 64)}\n${clean(nonce, 128)}\n${String(rawBody ?? "")}`)
    .digest("hex");
}

export function verifyDouyinSignedRequest({
  headers = {},
  rawBody = "",
  secret,
  now = Date.now(),
  toleranceSeconds = MAX_CLOCK_SKEW_SECONDS
}) {
  const timestamp = clean(headers["x-huamei-timestamp"] || headers["x-douyin-timestamp"], 64);
  const nonce = clean(headers["x-huamei-nonce"] || headers["x-douyin-nonce"], 128);
  const supplied = normalizedSignatureValue(headers["x-huamei-signature"] || headers["x-douyin-signature"]);
  if (!timestamp || !nonce || !supplied) {
    throw connectorError("DOUYIN_SIGNATURE_MISSING", "抖音回调缺少签名请求头", 401);
  }
  const timestampMs = Number(timestamp) * 1_000;
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > toleranceSeconds * 1_000) {
    throw connectorError("DOUYIN_TIMESTAMP_INVALID", "抖音回调时间戳已过期", 401);
  }
  const expectedHex = douyinSignature({ secret, timestamp, nonce, rawBody });
  const suppliedAsHex = safeEqualText(expectedHex, supplied.toLowerCase());
  const expectedBase64 = Buffer.from(expectedHex, "hex").toString("base64");
  const suppliedAsBase64 = safeEqualText(expectedBase64, supplied);
  if (!suppliedAsHex && !suppliedAsBase64) {
    throw connectorError("DOUYIN_SIGNATURE_INVALID", "抖音回调签名无效", 401);
  }
  return { timestamp, nonce, signature:expectedHex };
}

const configuredTenant = (env, key) => {
  try {
    return normalizeTenantId(env?.[key], env?.HUAMEI_PUBLIC_TENANT_ID || env?.HUAMEI_DEFAULT_TENANT_ID);
  } catch (error) {
    error.status = 503;
    error.code = "CHANNEL_TENANT_INVALID";
    throw error;
  }
};

const wecomApiOrigin = (env) => {
  try {
    const parsed = new URL(clean(env?.HUAMEI_CHANNEL_WECOM_API_ORIGIN, 512) || DEFAULT_WECOM_API_ORIGIN);
    if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
      throw new Error("insecure");
    }
    return parsed.origin;
  } catch {
    throw connectorError("WECOM_API_ORIGIN_INVALID", "企业微信API地址无效", 503);
  }
};

export function clearWecomAccessTokenCache() {
  wecomAccessTokenCache.clear();
}

async function getWecomAccessToken({
  env,
  fetchImpl = fetch,
  now = Date.now()
}) {
  const corpId = clean(env.HUAMEI_CHANNEL_WECOM_CORP_ID);
  const secret = clean(env.HUAMEI_CHANNEL_WECOM_SECRET);
  const cacheKey = createHash("sha256").update(`${corpId}\0${secret}`).digest("hex");
  const cached = wecomAccessTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > now + 60_000) return cached.token;
  const endpoint = new URL("/cgi-bin/gettoken", wecomApiOrigin(env));
  endpoint.searchParams.set("corpid", corpId);
  endpoint.searchParams.set("corpsecret", secret);
  let response;
  try {
    response = await fetchImpl(endpoint, { method:"GET", signal:AbortSignal.timeout(8_000) });
  } catch {
    throw connectorError("WECOM_TOKEN_UNAVAILABLE", "企业微信访问令牌服务暂时不可用", 503);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.errcode || !payload.access_token) {
    throw connectorError("WECOM_TOKEN_REJECTED", "企业微信访问令牌获取失败", 503, [{
      errcode:payload.errcode,
      errmsg:clean(payload.errmsg, 300)
    }]);
  }
  const expiresIn = Math.max(300, Number(payload.expires_in) || 7_200);
  wecomAccessTokenCache.set(cacheKey, {
    token:payload.access_token,
    expiresAt:now + expiresIn * 1_000
  });
  return payload.access_token;
}

export async function sendWecomAppText({
  env,
  toUser,
  text,
  fetchImpl = fetch,
  now = Date.now()
}) {
  requireEnvironment(env, [
    "HUAMEI_CHANNEL_WECOM_CORP_ID",
    "HUAMEI_CHANNEL_WECOM_AGENT_ID",
    "HUAMEI_CHANNEL_WECOM_SECRET"
  ]);
  const accessToken = await getWecomAccessToken({ env, fetchImpl, now });
  const endpoint = new URL("/cgi-bin/message/send", wecomApiOrigin(env));
  endpoint.searchParams.set("access_token", accessToken);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({
        touser:clean(toUser, 128),
        msgtype:"text",
        agentid:Number(env.HUAMEI_CHANNEL_WECOM_AGENT_ID),
        text:{ content:clean(text, 2_048) },
        safe:Number(env.HUAMEI_CHANNEL_WECOM_SAFE_MODE || 0) === 1 ? 1 : 0,
        enable_duplicate_check:1,
        duplicate_check_interval:Math.max(1_800, Number(env.HUAMEI_CHANNEL_WECOM_DUPLICATE_CHECK_SECONDS) || 1_800)
      }),
      signal:AbortSignal.timeout(8_000)
    });
  } catch {
    throw connectorError("WECOM_SEND_UNAVAILABLE", "企业微信消息服务暂时不可用", 503);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.errcode) {
    throw connectorError("WECOM_SEND_REJECTED", "企业微信消息发送失败", 502, [{
      errcode:payload.errcode,
      errmsg:clean(payload.errmsg, 300),
      invaliduser:clean(payload.invaliduser, 300)
    }]);
  }
  return {
    status:"sent",
    delivered:true,
    external_message_id:clean(payload.msgid, 160) || null,
    sent_at:new Date(now).toISOString()
  };
}

const assertWecomConfigured = (env) => requireEnvironment(env, [
  "HUAMEI_CHANNEL_WECOM_CORP_ID",
  "HUAMEI_CHANNEL_WECOM_AGENT_ID",
  "HUAMEI_CHANNEL_WECOM_SECRET",
  "HUAMEI_CHANNEL_WECOM_TOKEN",
  "HUAMEI_CHANNEL_WECOM_ENCODING_AES_KEY",
  "HUAMEI_CHANNEL_WECOM_TENANT_ID"
]);

const assertDouyinConfigured = (env) => requireEnvironment(env, [
  "HUAMEI_CHANNEL_DOUYIN_APP_ID",
  "HUAMEI_CHANNEL_DOUYIN_APP_SECRET",
  "HUAMEI_CHANNEL_DOUYIN_WEBHOOK_SECRET",
  "HUAMEI_CHANNEL_DOUYIN_VERIFY_TOKEN",
  "HUAMEI_CHANNEL_DOUYIN_REPLY_WEBHOOK_URL",
  "HUAMEI_CHANNEL_DOUYIN_REPLY_TOKEN",
  "HUAMEI_CHANNEL_DOUYIN_TENANT_ID"
]);

const handoverSuppressed = (result) => result?.delivery?.suppress_ai === true
  || result?.handover?.status === "active";

export async function handleWecomWebhook({
  method,
  url,
  rawBody = "",
  env = process.env,
  requestId,
  processEnvelope,
  fetchImpl = fetch,
  now = Date.now()
}) {
  assertWecomConfigured(env);
  const corpId = clean(env.HUAMEI_CHANNEL_WECOM_CORP_ID, 128);
  const token = clean(env.HUAMEI_CHANNEL_WECOM_TOKEN, 128);
  const encodingAesKey = clean(env.HUAMEI_CHANNEL_WECOM_ENCODING_AES_KEY, 128);
  if (method === "GET") {
    const signature = url.searchParams.get("msg_signature") || "";
    const timestamp = url.searchParams.get("timestamp") || "";
    const nonce = url.searchParams.get("nonce") || "";
    const encrypted = url.searchParams.get("echostr") || "";
    if (!verifyWecomSignature({ token, timestamp, nonce, encrypted }, signature)) {
      throw connectorError("WECOM_SIGNATURE_INVALID", "企业微信URL验证签名无效", 401);
    }
    const decrypted = decryptWecomMessage(encrypted, encodingAesKey);
    if (decrypted.receive_id !== corpId) {
      throw connectorError("WECOM_RECEIVE_ID_MISMATCH", "企业微信回调不属于当前企业", 403);
    }
    return { status:200, contentType:"text/plain; charset=utf-8", body:decrypted.message, audit:{ verification:"passed" } };
  }
  if (method !== "POST") {
    throw connectorError("METHOD_NOT_ALLOWED", "企业微信回调仅支持GET和POST", 405);
  }

  const outer = parseWecomXml(rawBody);
  const encrypted = clean(outer.Encrypt, 64 * 1024);
  const signature = url.searchParams.get("msg_signature") || "";
  const timestamp = url.searchParams.get("timestamp") || "";
  const nonce = url.searchParams.get("nonce") || "";
  if (!verifyWecomSignature({ token, timestamp, nonce, encrypted }, signature)) {
    throw connectorError("WECOM_SIGNATURE_INVALID", "企业微信回调签名无效", 401);
  }
  const decrypted = decryptWecomMessage(encrypted, encodingAesKey);
  if (decrypted.receive_id !== corpId) {
    throw connectorError("WECOM_RECEIVE_ID_MISMATCH", "企业微信回调不属于当前企业", 403);
  }
  const message = parseWecomXml(decrypted.message);
  if (message.MsgType !== "text" || !clean(message.Content)) {
    return {
      status:200,
      contentType:"text/plain; charset=utf-8",
      body:"success",
      audit:{ message_id:clean(message.MsgId, 160) || null, outcome:"ignored_non_text" }
    };
  }

  const tenantId = configuredTenant(env, "HUAMEI_CHANNEL_WECOM_TENANT_ID");
  const envelope = normalizeChannelInbound("wecom", {
    tenant_id:tenantId,
    MsgId:message.MsgId,
    FromUserName:message.FromUserName,
    ToUserName:message.ToUserName,
    Content:message.Content,
    CreateTime:message.CreateTime,
    context:{
      source_channel:"wecom",
      wecom_msg_type:message.MsgType,
      wecom_agent_id:clean(env.HUAMEI_CHANNEL_WECOM_AGENT_ID, 32)
    }
  });
  const result = await processEnvelope(envelope, { requestId, caller:"wecom-webhook" });
  if (handoverSuppressed(result)) {
    return {
      status:200,
      contentType:"text/plain; charset=utf-8",
      body:"success",
      audit:{
        message_id:envelope.message.id,
        run_id:result.run_id,
        outcome:"handover_suppressed"
      }
    };
  }
  const outbound = formatChannelOutbound("wecom", result, { env });
  const content = clean(outbound.text?.content, 2_000);
  if (!content) {
    return { status:200, contentType:"text/plain; charset=utf-8", body:"success", audit:{ outcome:"empty_reply" } };
  }
  const replyMode = clean(env.HUAMEI_CHANNEL_WECOM_REPLY_MODE || "passive", 32).toLowerCase();
  if (replyMode === "active") {
    const delivery = await sendWecomAppText({ env, toUser:message.FromUserName, text:content, fetchImpl, now });
    return {
      status:200,
      contentType:"text/plain; charset=utf-8",
      body:"success",
      audit:{
        message_id:envelope.message.id,
        run_id:result.run_id,
        outcome:"active_send",
        delivery
      }
    };
  }
  if (replyMode !== "passive") {
    throw connectorError("WECOM_REPLY_MODE_INVALID", "企业微信回复模式仅支持passive或active", 503);
  }
  const replyTimestamp = Math.floor(now / 1_000);
  const plaintext = buildWecomTextReply({
    toUser:message.FromUserName,
    fromUser:message.ToUserName || corpId,
    content,
    timestamp:replyTimestamp
  });
  return {
    status:200,
    contentType:"application/xml; charset=utf-8",
    body:buildWecomEncryptedReply({
      plaintextXml:plaintext,
      token,
      encodingAesKey,
      receiveId:corpId,
      timestamp:replyTimestamp
    }),
    audit:{
      message_id:envelope.message.id,
      run_id:result.run_id,
      outcome:"passive_reply",
      delivery:{ status:"response_returned_to_wecom", delivered:false, external_message_id:null, sent_at:null }
    }
  };
}

const validRelayUrl = (value) => {
  try {
    const parsed = new URL(value);
    const loopback = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return "";
    return parsed.toString();
  } catch {
    return "";
  }
};

export async function sendDouyinRelay({
  env,
  conversationId,
  recipient,
  outbound,
  idempotencyKey,
  fetchImpl = fetch,
  now = Date.now()
}) {
  const relayUrl = validRelayUrl(env.HUAMEI_CHANNEL_DOUYIN_REPLY_WEBHOOK_URL);
  if (!relayUrl) {
    throw connectorError("DOUYIN_REPLY_URL_INVALID", "抖音回复连接器地址必须使用HTTPS，本机联调除外", 503);
  }
  let response;
  try {
    response = await fetchImpl(relayUrl, {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        Authorization:`Bearer ${clean(env.HUAMEI_CHANNEL_DOUYIN_REPLY_TOKEN, 512)}`,
        "Idempotency-Key":clean(idempotencyKey, 160)
      },
      body:JSON.stringify({
        schema_version:"1.0",
        provider:"douyin",
        tenant_id:outbound.tenant_id,
        channel:"douyin",
        conversation_id:conversationId,
        recipient:{ open_id:recipient },
        reply:{
          text:outbound.outbound?.text || "",
          segments:outbound.outbound?.segments || []
        },
        metadata:outbound.metadata || {}
      }),
      signal:AbortSignal.timeout(10_000)
    });
  } catch {
    throw connectorError("DOUYIN_RELAY_UNAVAILABLE", "抖音回复连接器暂时不可用", 503);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw connectorError("DOUYIN_RELAY_REJECTED", "抖音回复连接器拒绝了消息", 502, [{
      status:response.status,
      message:clean(payload.message || payload.error?.message, 300)
    }]);
  }
  const delivered = payload.delivered === true;
  return {
    status:delivered ? "sent" : "accepted",
    delivered,
    external_message_id:clean(payload.message_id || payload.msg_id || payload.data?.message_id, 160) || null,
    sent_at:delivered ? new Date(now).toISOString() : null,
    relay_status_code:response.status
  };
}

const douyinChallengeAuthorized = ({ url, env }) => {
  const expected = clean(env.HUAMEI_CHANNEL_DOUYIN_VERIFY_TOKEN, 512);
  const supplied = clean(url.searchParams.get("token") || url.searchParams.get("hub.verify_token"), 512);
  return Boolean(expected && supplied && safeEqualText(expected, supplied));
};

export async function handleDouyinWebhook({
  method,
  url,
  headers = {},
  rawBody = "",
  env = process.env,
  requestId,
  processEnvelope,
  fetchImpl = fetch,
  now = Date.now()
}) {
  assertDouyinConfigured(env);
  if (method === "GET") {
    const challenge = clean(url.searchParams.get("challenge"), 512);
    if (!challenge) throw connectorError("DOUYIN_CHALLENGE_MISSING", "抖音回调缺少challenge", 400);
    let authorized = douyinChallengeAuthorized({ url, env });
    if (!authorized) {
      try {
        verifyDouyinSignedRequest({
          headers,
          rawBody:"",
          secret:env.HUAMEI_CHANNEL_DOUYIN_WEBHOOK_SECRET,
          now
        });
        authorized = true;
      } catch {}
    }
    if (!authorized) throw connectorError("DOUYIN_VERIFY_UNAUTHORIZED", "抖音回调验证令牌无效", 401);
    return { status:200, contentType:"text/plain; charset=utf-8", body:challenge, audit:{ verification:"passed" } };
  }
  if (method !== "POST") {
    throw connectorError("METHOD_NOT_ALLOWED", "抖音回调仅支持GET和POST", 405);
  }
  verifyDouyinSignedRequest({
    headers,
    rawBody,
    secret:env.HUAMEI_CHANNEL_DOUYIN_WEBHOOK_SECRET,
    now
  });
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw connectorError("DOUYIN_PAYLOAD_INVALID", "抖音回调不是有效JSON", 400);
  }
  const tenantId = configuredTenant(env, "HUAMEI_CHANNEL_DOUYIN_TENANT_ID");
  let envelope;
  try {
    envelope = normalizeChannelInbound("douyin", { ...payload, tenant_id:tenantId });
  } catch (error) {
    if (error.code === "VALIDATION_ERROR" && !clean(payload.text || payload.content || payload.message?.text || payload.message?.content)) {
      return {
        status:200,
        contentType:"application/json; charset=utf-8",
        body:{ status:"ignored", reason:"non_text_event", request_id:requestId },
        audit:{ outcome:"ignored_non_text" }
      };
    }
    throw error;
  }
  const result = await processEnvelope(envelope, { requestId, caller:"douyin-webhook" });
  if (handoverSuppressed(result)) {
    return {
      status:200,
      contentType:"application/json; charset=utf-8",
      body:{ status:"accepted", delivery:"handover_suppressed", request_id:requestId, run_id:result.run_id },
      audit:{ outcome:"handover_suppressed", message_id:envelope.message.id, run_id:result.run_id }
    };
  }
  const outbound = formatChannelOutbound("douyin", result, { env });
  const delivery = await sendDouyinRelay({
    env,
    conversationId:envelope.conversation_id,
    recipient:envelope.actor.external_user_id,
    outbound,
    idempotencyKey:envelope.message.id,
    fetchImpl,
    now
  });
  return {
    status:202,
    contentType:"application/json; charset=utf-8",
    body:{
      status:delivery.delivered ? "delivered" : "accepted",
      request_id:requestId,
      run_id:result.run_id,
      message_id:envelope.message.id,
      delivery
    },
    audit:{
      outcome:"relay_completed",
      message_id:envelope.message.id,
      run_id:result.run_id,
      delivery
    }
  };
}
