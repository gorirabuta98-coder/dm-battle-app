import { supabase } from '@/lib/supabase';

export function compressImageToDataUrl(file: File, maxHeight = 960): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = img.height > maxHeight ? maxHeight / img.height : 1;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('Canvas error'));
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.92));
      };
      img.onerror = reject;
      img.src = reader.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return await res.blob();
}

export async function uploadCardImageToSupabase(
  file: File,
  folder = 'cards',
  maxHeight = 960
): Promise<string> {
  const compressedDataUrl = await compressImageToDataUrl(file, maxHeight);
  const blob = await dataUrlToBlob(compressedDataUrl);
  const filePath = `${folder}/${Date.now()}-${Math.random().toString(36).substring(2, 8)}.jpg`;

  const { error } = await supabase.storage
    .from('card-images')
    .upload(filePath, blob, {
      contentType: 'image/jpeg',
      upsert: false,
    });

  if (error) {
    throw error;
  }

  const { data } = supabase.storage.from('card-images').getPublicUrl(filePath);
  return data.publicUrl;
}