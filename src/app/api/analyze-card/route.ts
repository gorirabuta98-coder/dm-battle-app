import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const { imageUrl } = await req.json();
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return NextResponse.json({ error: 'GEMINI_API_KEY is not set' }, { status: 500 });
    }
    if (!imageUrl || !imageUrl.startsWith('data:image')) {
      return NextResponse.json({ error: 'Invalid image data' }, { status: 400 });
    }

    // DataURLからMIMEタイプとBase64本体を抽出
    const matches = imageUrl.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
    if (!matches) {
      return NextResponse.json({ error: 'Failed to parse image' }, { status: 400 });
    }
    const mimeType = matches[1];
    const base64Data = matches[2];

    const prompt = `あなたはデュエル・マスターズのカード解析AIです。このカード画像を読み取り、以下のJSON形式のみで出力してください（マークダウン記法は不要、純粋なJSONのみ）。

{
  "name": "カード名（読み取れなければ空文字）",
  "cost": 数値（マナコスト、不明なら0）,
  "text": "カード能力の要約（日本語で簡潔に）",
  "isShieldTrigger": true または false（S・トリガーやG・ストライク等があればtrue）,
  "onPlayLookDeck": 数値（バトルゾーンに出た時や唱えた時に山札の上から見る枚数。例：「山札の上から4枚見て」なら4、該当しなければ0）,
  "onPlayText": "登場時・詠唱時効果の簡潔な説明（なければ空文字）",
  "onAttackEvolution": true または false（攻撃時に手札から進化・侵略・革命チェンジできる効果があればtrue）,
  "onAttackText": "攻撃時効果の簡潔な説明（なければ空文字）"
}`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                {
                  inline_data: {
                    mime_type: mimeType,
                    data: base64Data,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
          },
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('Gemini API error:', errText);
      return NextResponse.json({ error: 'Gemini API failed' }, { status: 500 });
    }

    const data = await response.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const parsed = JSON.parse(rawText);

    return NextResponse.json(parsed);
  } catch (error) {
    console.error('Analyze card error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}