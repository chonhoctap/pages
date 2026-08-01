import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const HIVE_ENDPOINT = 'https://api.thehive.ai/api/v3/chat/completions';
const HIVE_MODEL = 'hive/vision-language-model';
const HIVE_MEDIA_BATCH_SIZE = 5;
const HIVE_MAX_MEDIA_BATCHES = 4;

const CATEGORY_VALUES = [
  'sexual_content',
  'child_safety',
  'hate',
  'bullying',
  'violence',
  'self_harm',
  'drugs',
  'weapons',
  'spam_scam',
  'personal_data',
  'other'
] as const;

type HiveDecision = {
  decision: 'allow' | 'block' | 'manual_review';
  categories: string[];
  reason: string;
  confidence: number;
};

type HiveCheck = {
  decision: HiveDecision;
  response: Record<string, unknown>;
  kind: 'text_image' | 'video';
};

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { ...corsHeaders, 'Cache-Control': 'no-store' }
  });
}

function wait(milliseconds: number) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function safeReason(value: unknown, fallback: string) {
  const reason = String(value || '').replace(/\s+/gu, ' ').trim();
  return reason ? reason.slice(0, 500) : fallback;
}

function hivePrompt(text: string, kind: 'text_image' | 'video') {
  const mediaDescription = kind === 'video'
    ? 'Hãy đánh giá toàn bộ các khung hình đại diện của video.'
    : 'Hãy đánh giá văn bản và toàn bộ hình ảnh đính kèm như một nội dung thống nhất.';
  return `Bạn là bộ kiểm duyệt an toàn cho diễn đàn học sinh Việt Nam "Chốn Học Tập".
${mediaDescription}

QUY TẮC:
- BLOCK: tình dục hoặc khỏa thân rõ ràng; bóc lột trẻ em; thù ghét; xúc phạm/quấy rối nhắm vào người cụ thể; đe dọa bạo lực đáng tin; máu me nghiêm trọng; cổ súy tự hại; mua bán ma túy/vũ khí; lừa đảo, spam nguy hiểm; công khai dữ liệu riêng tư của người khác.
- MANUAL_REVIEW: nội dung nhạy cảm nhưng ngữ cảnh chưa chắc chắn, hình ảnh gợi dục không rõ mức độ, thông tin cá nhân có thể thuộc chính người đăng, hoặc không đủ dữ liệu để kết luận an toàn.
- ALLOW: thảo luận học tập, y tế/sinh học có tính giáo dục, tin tức có ngữ cảnh, bất đồng lịch sự, đùa vui không tấn công ai và nội dung thông thường.
- Không chặn chỉ vì có từ nhạy cảm nếu nội dung đang giải thích kiến thức một cách phù hợp.
- Phải xem cả chữ trong hình và cách viết lách luật/teencode tiếng Việt.

VĂN BẢN NGƯỜI DÙNG:
${text.trim() || '(không có văn bản)'}

Chỉ trả về JSON đúng schema. Lý do viết ngắn gọn bằng tiếng Việt.`;
}

function responseSchema() {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'chon_hoctap_moderation',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          decision: { type: 'string', enum: ['allow', 'block', 'manual_review'] },
          categories: {
            type: 'array',
            items: { type: 'string', enum: CATEGORY_VALUES }
          },
          reason: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 }
        },
        required: ['decision', 'categories', 'reason', 'confidence'],
        additionalProperties: false
      }
    }
  };
}

function parseHiveDecision(response: Record<string, unknown>): HiveDecision {
  const choices = Array.isArray(response.choices) ? response.choices : [];
  const content = (choices[0] as { message?: { content?: unknown } } | undefined)
    ?.message?.content;
  if (typeof content !== 'string') throw new Error('Hive không trả về nội dung kiểm duyệt.');
  const parsed = JSON.parse(content) as Partial<HiveDecision>;
  if (!['allow', 'block', 'manual_review'].includes(String(parsed.decision))) {
    throw new Error('Hive trả về quyết định không hợp lệ.');
  }
  const confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error('Hive trả về độ tin cậy không hợp lệ.');
  }
  return {
    decision: parsed.decision as HiveDecision['decision'],
    categories: Array.isArray(parsed.categories)
      ? parsed.categories.filter(value => CATEGORY_VALUES.includes(value as typeof CATEGORY_VALUES[number]))
      : [],
    reason: safeReason(parsed.reason, 'Hive phát hiện nội dung cần xem xét.'),
    confidence
  };
}

async function callHive(
  hiveKey: string,
  text: string,
  mediaRows: Array<{ media_type: string; media_url: string }>,
  kind: 'text_image' | 'video'
): Promise<HiveCheck> {
  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: hivePrompt(text, kind) }
  ];
  for (const item of mediaRows) {
    if (item.media_type === 'image') {
      content.push({ type: 'image_url', image_url: { url: item.media_url } });
    } else if (item.media_type === 'video') {
      content.push({
        type: 'media_url',
        media_url: {
          url: item.media_url,
          sampling: { strategy: 'fps', fps: 0.5 },
          prompt_scope: 'once'
        }
      });
    }
  }

  let lastError = 'Hive tạm thời không phản hồi.';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(HIVE_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${hiveKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: HIVE_MODEL,
          messages: [{ role: 'user', content }],
          response_format: responseSchema(),
          max_tokens: 220,
          temperature: 0,
          top_p: 0.1
        }),
        signal: AbortSignal.timeout(60000)
      });
      const responseText = await response.text();
      if (!response.ok) {
        lastError = `Hive HTTP ${response.status}: ${responseText.slice(0, 300)}`;
        if ((response.status === 429 || response.status >= 500) && attempt === 0) {
          await wait(1000);
          continue;
        }
        throw new Error(lastError);
      }
      const parsed = JSON.parse(responseText) as Record<string, unknown>;
      return { decision: parseHiveDecision(parsed), response: parsed, kind };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt === 0 && /timeout|network|fetch/iu.test(lastError)) {
        await wait(1000);
        continue;
      }
    }
  }
  throw new Error(lastError);
}

function combineChecks(checks: HiveCheck[]): HiveDecision {
  const blocked = checks.find(check => check.decision.decision === 'block');
  if (blocked) return blocked.decision;
  const manual = checks.find(check => check.decision.decision === 'manual_review');
  if (manual) return manual.decision;
  const categories = [...new Set(checks.flatMap(check => check.decision.categories))];
  const confidence = checks.length
    ? Math.min(...checks.map(check => check.decision.confidence))
    : 1;
  return {
    decision: 'allow',
    categories,
    reason: 'Nội dung phù hợp với quy tắc cộng đồng.',
    confidence
  };
}

async function notifyManualReview(
  admin: ReturnType<typeof createClient>,
  actorId: string,
  id: string,
  isPost: boolean
) {
  const { data: staff } = await admin
    .from('profiles')
    .select('id')
    .in('role', ['moderator', 'admin'])
    .eq('account_status', 'active');
  if (!staff?.length) return;
  await admin.from('forum_notifications').insert(staff.map(member => ({
    recipient_id: member.id,
    actor_id: actorId,
    type: 'moderation',
    post_id: isPost ? id : null,
    comment_id: isPost ? null : id,
    message: isPost
      ? 'Có bài viết cần người quản trị xem xét sau bước kiểm duyệt Hive.'
      : 'Có bình luận cần người quản trị xem xét sau bước kiểm duyệt Hive.'
  })));
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Chỉ hỗ trợ POST.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const hiveKey = Deno.env.get('HIVE_API_KEY') || '';
  const authorization = request.headers.get('Authorization') || '';
  if (!supabaseUrl || !serviceKey) {
    return json({ error: 'Máy chủ kiểm duyệt chưa được cấu hình.' }, 503);
  }
  if (!authorization.startsWith('Bearer ')) return json({ error: 'Bạn cần đăng nhập.' }, 401);

  try {
    const { postId, commentId } = await request.json();
    if ((!postId && !commentId) || (postId && commentId)) {
      return json({ error: 'Cần đúng một mã bài viết hoặc bình luận.' }, 400);
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const token = authorization.slice(7);
    const { data: userData, error: userError } = await admin.auth.getUser(token);
    if (userError || !userData.user) return json({ error: 'Phiên đăng nhập không hợp lệ.' }, 401);

    const { data: actor } = await admin
      .from('profiles')
      .select('id, role, account_status')
      .eq('id', userData.user.id)
      .single();
    if (!actor || actor.account_status !== 'active') return json({ error: 'Tài khoản bị hạn chế.' }, 403);

    const isPost = Boolean(postId);
    const table = isPost ? 'forum_posts' : 'forum_comments';
    const id = postId || commentId;
    const select = isPost
      ? 'id, author_id, title, body, moderation_status, ai_moderation_status'
      : 'id, post_id, author_id, body, moderation_status, ai_moderation_status';
    const { data: record, error: recordError } = await admin
      .from(table)
      .select(select)
      .eq('id', id)
      .single();
    if (recordError || !record) return json({ error: 'Không tìm thấy nội dung.' }, 404);
    if (record.author_id !== actor.id && !['moderator', 'admin'].includes(actor.role)) {
      return json({ error: 'Bạn không có quyền kiểm duyệt nội dung này.' }, 403);
    }
    if (
      record.author_id === actor.id
      && !['moderator', 'admin'].includes(actor.role)
      && record.moderation_status === 'rejected'
    ) {
      return json({ error: 'Nội dung đã bị từ chối. Hãy chỉnh sửa trước khi kiểm tra lại.' }, 403);
    }

    const mediaTable = isPost ? 'forum_post_media' : 'forum_comment_media';
    const ownerColumn = isPost ? 'post_id' : 'comment_id';
    const { data: mediaRows, error: mediaError } = await admin
      .from(mediaTable)
      .select('media_type, media_url')
      .eq(ownerColumn, id)
      .order('sort_order');
    if (mediaError) throw mediaError;

    const textToCheck = isPost ? `${record.title}\n\n${record.body || ''}` : (record.body || '');
    const images = (mediaRows || []).filter(item => item.media_type === 'image' && item.media_url);
    const videos = (mediaRows || []).filter(item => item.media_type === 'video' && item.media_url);
    const hasAudio = (mediaRows || []).some(item => item.media_type === 'audio');
    const imageBatches = Array.from(
      { length: Math.ceil(images.length / HIVE_MEDIA_BATCH_SIZE) },
      (_, index) => images.slice(index * HIVE_MEDIA_BATCH_SIZE, (index + 1) * HIVE_MEDIA_BATCH_SIZE)
    );

    const checks: HiveCheck[] = [];
    const manualReasons: string[] = [];
    if (!hiveKey) {
      manualReasons.push('Hive Moderation chưa được cấu hình khóa API.');
    } else if (imageBatches.length > HIVE_MAX_MEDIA_BATCHES || videos.length > 2) {
      manualReasons.push('Nội dung có quá nhiều tệp để kiểm tra tự động an toàn.');
    } else {
      try {
        if (textToCheck.trim() || imageBatches.length) {
          if (!imageBatches.length) {
            checks.push(await callHive(hiveKey, textToCheck, [], 'text_image'));
          } else {
            for (const batch of imageBatches) {
              checks.push(await callHive(hiveKey, textToCheck, batch, 'text_image'));
            }
          }
        }
        for (const video of videos) {
          checks.push(await callHive(hiveKey, textToCheck, [video], 'video'));
        }
      } catch (error) {
        console.error('Hive moderation failed', error instanceof Error ? error.message : error);
        manualReasons.push('Hive tạm thời không hoàn tất kiểm duyệt.');
      }
    }
    if (hasAudio) {
      manualReasons.push('Hive chưa hỗ trợ kiểm duyệt giọng nói tiếng Việt.');
    }

    const hiveDecision = combineChecks(checks);
    const shouldBlock = hiveDecision.decision === 'block';
    const needsManualReview = !shouldBlock && (
      hiveDecision.decision === 'manual_review' || manualReasons.length > 0
    );
    const reason = shouldBlock
      ? hiveDecision.reason
      : needsManualReview
        ? [hiveDecision.decision === 'manual_review' ? hiveDecision.reason : '', ...manualReasons]
          .filter(Boolean).join(' ')
        : null;
    const aiStatus = shouldBlock
      ? 'rejected'
      : needsManualReview
        ? 'manual_review'
        : 'approved';
    const result = {
      provider: 'hive',
      model: HIVE_MODEL,
      decision: hiveDecision,
      manualReasons,
      checkedAt: new Date().toISOString(),
      checks: checks.map(check => ({
        kind: check.kind,
        decision: check.decision,
        taskId: check.response.id || null
      }))
    };

    if (isPost) {
      const status = shouldBlock ? 'rejected' : needsManualReview ? 'pending_review' : 'published';
      const { error } = await admin.from('forum_posts').update({
        moderation_status: status,
        moderation_reason: reason,
        visibility: shouldBlock ? 'hidden' : 'visible',
        ai_moderation_status: aiStatus,
        ai_moderation_reason: reason,
        ai_moderation_result: result,
        ai_moderated_at: new Date().toISOString()
      }).eq('id', id);
      if (error) throw error;
    } else {
      const status = shouldBlock ? 'rejected' : needsManualReview ? 'pending_review' : 'published';
      const { error } = await admin.from('forum_comments').update({
        moderation_status: status,
        moderation_reason: reason,
        ai_moderation_status: aiStatus,
        ai_moderation_reason: reason,
        ai_moderation_result: result,
        ai_moderated_at: new Date().toISOString()
      }).eq('id', id);
      if (error) throw error;
    }

    if (needsManualReview && record.ai_moderation_status !== 'manual_review') {
      await notifyManualReview(admin, actor.id, id, isPost);
    }

    return json({
      provider: 'hive',
      allowed: !shouldBlock,
      published: !shouldBlock && !needsManualReview,
      manualReview: needsManualReview,
      reason
    });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : 'Lỗi kiểm duyệt.' }, 500);
  }
});
