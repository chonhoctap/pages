import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { ...corsHeaders, 'Cache-Control': 'no-store' }
  });
}

function flaggedLabels(categories: Record<string, boolean> = {}) {
  return Object.entries(categories)
    .filter(([, value]) => value)
    .map(([name]) => name)
    .join(', ');
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Chỉ hỗ trợ POST.' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const openaiKey = Deno.env.get('OPENAI_API_KEY');
  const authorization = request.headers.get('Authorization') || '';
  if (!supabaseUrl || !serviceKey || !openaiKey) {
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
    const select = isPost ? 'id, author_id, title, body' : 'id, post_id, author_id, body';
    const { data: record, error: recordError } = await admin
      .from(table)
      .select(select)
      .eq('id', id)
      .single();
    if (recordError || !record) return json({ error: 'Không tìm thấy nội dung.' }, 404);
    if (record.author_id !== actor.id && !['moderator', 'admin'].includes(actor.role)) {
      return json({ error: 'Bạn không có quyền kiểm duyệt nội dung này.' }, 403);
    }

    const mediaTable = isPost ? 'forum_post_media' : 'forum_comment_media';
    const ownerColumn = isPost ? 'post_id' : 'comment_id';
    const { data: mediaRows, error: mediaError } = await admin
      .from(mediaTable)
      .select('media_type, media_url')
      .eq(ownerColumn, id)
      .order('sort_order');
    if (mediaError) throw mediaError;

    const hasUnsupportedMedia = (mediaRows || [])
      .some(item => ['video', 'audio'].includes(item.media_type));
    const requiresManualReview = isPost && hasUnsupportedMedia;
    const textToCheck = isPost ? `${record.title}\n\n${record.body || ''}` : (record.body || '');
    const input: Array<Record<string, unknown>> = [];
    if (textToCheck.trim()) input.push({ type: 'text', text: textToCheck });
    (mediaRows || [])
      .filter(item => item.media_type === 'image' && item.media_url)
      .slice(0, 5)
      .forEach(item => input.push({
        type: 'image_url',
        image_url: { url: item.media_url }
      }));

    let result: Record<string, unknown> & {
      flagged: boolean;
      categories: Record<string, boolean>;
    } = { flagged: false, categories: {} };
    if (input.length) {
      const moderationResponse = await fetch('https://api.openai.com/v1/moderations', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model: 'omni-moderation-latest', input })
      });
      if (!moderationResponse.ok) {
        console.error('OpenAI moderation failed', moderationResponse.status, await moderationResponse.text());
        return json({ error: 'AI tạm thời chưa kiểm tra được. Nội dung vẫn ở hàng chờ.' }, 502);
      }

      const moderation = await moderationResponse.json();
      const moderationResult = moderation.results?.[0];
      if (!moderationResult) return json({ error: 'AI không trả về kết quả hợp lệ.' }, 502);
      result = moderationResult;
    }
    const reason = flaggedLabels(result.categories)
      || (requiresManualReview ? 'Video/âm thanh trong bài viết cần quản trị viên duyệt.' : null);

    if (isPost) {
      const status = result.flagged ? 'rejected' : requiresManualReview ? 'pending_review' : 'published';
      const aiStatus = result.flagged ? 'rejected' : requiresManualReview ? 'manual_review' : 'approved';
      const { error } = await admin.from('forum_posts').update({
        moderation_status: status,
        moderation_reason: reason,
        visibility: result.flagged ? 'hidden' : 'visible',
        ai_moderation_status: aiStatus,
        ai_moderation_reason: reason,
        ai_moderation_result: result,
        ai_moderated_at: new Date().toISOString()
      }).eq('id', id);
      if (error) throw error;
    } else {
      // Bình luận không qua hàng chờ thủ công. AI kiểm tra văn bản và ảnh;
      // video/âm thanh đi kèm không được endpoint Moderations phân tích.
      const status = result.flagged ? 'rejected' : 'published';
      const { error } = await admin.from('forum_comments').update({
        moderation_status: status,
        moderation_reason: reason
      }).eq('id', id);
      if (error) throw error;
    }

    if (requiresManualReview && !result.flagged) {
      const { data: staff } = await admin
        .from('profiles').select('id')
        .in('role', ['moderator', 'admin']).eq('account_status', 'active');
      if (staff?.length) {
        await admin.from('forum_notifications').insert(staff.map(member => ({
          recipient_id: member.id,
          actor_id: actor.id,
          type: 'moderation',
          post_id: id,
          comment_id: null,
          message: 'Video hoặc âm thanh mới đang chờ duyệt thủ công.'
        })));
      }
    }

    return json({
      allowed: !result.flagged,
      published: !result.flagged && !requiresManualReview,
      manualReview: requiresManualReview && !result.flagged,
      reason
    });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : 'Lỗi kiểm duyệt.' }, 500);
  }
});
