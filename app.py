import os
import uuid
import threading
import subprocess
from flask import Flask, render_template, request, redirect, url_for, jsonify, send_file
import yt_dlp
import time

app = Flask(__name__)

# İndirilen dosyaların ve ilerleme bilgilerinin tutulduğu global sözlük
download_tasks = {}

# İndirilen dosyaların kaydedileceği klasörü oluşturun
if not os.path.exists("downloads"):
    os.makedirs("downloads")

# Ortak yt_dlp ayarları (örneğin Instagram gibi siteler için User-Agent ekleniyor)
def get_common_ydl_opts(video_url):
    opts = {
        'noplaylist': True,
        'http_headers': {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': video_url if "x.com" in video_url else 'https://www.instagram.com/'
        }
    }
    if "instagram.com" in video_url:
        opts['cookiefile'] = './instagram_cookies.txt'  # Cookie dosyası zorunlu
    return opts


@app.route('/')
def index():
    return render_template('index.html')

@app.route('/get_info', methods=['POST'])
def get_info():
    video_url = request.form.get('video_url')
    if not video_url:
        return redirect(url_for('index'))

    ydl_opts = get_common_ydl_opts(video_url)
    try:    
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(video_url, download=False)
    except Exception as e:
        return f"Video bilgisi alınırken hata oluştu: {e}"

    # Formatları üç kategoriye ayırıyoruz:
    combined_formats = []   # Video + Ses
    video_only_formats = [] # Sadece Video (video-only)
    audio_only_formats = [] # Sadece Ses
    
    for f in info.get("formats", []):
        if "instagram.com" in video_url or "x.com" in video_url:
            f['format_note'] = f.get('format_note') or f.get('quality')  # Alternatif alan
            # Tüm olası dosya boyutu anahtarlarını kontrol et
            f['filesize'] = (
                f.get('filesize') or 
                f.get('file_size') or 
                f.get('size') or 
                f.get('filesize_approx') or 
                0  # Fallback to 0 if none found
            )
        acodec = f.get("acodec")
        vcodec = f.get("vcodec")
        if vcodec != "none" and acodec != "none":
            combined_formats.append(f)
        elif vcodec != "none" and (acodec == "none" or acodec is None):
            video_only_formats.append(f)
        elif (vcodec == "none" or vcodec is None) and acodec != "none":
            audio_only_formats.append(f)

    # Sıralama: combined ve video-only için yükseklik, audio-only için abr (bitrate)
    combined_formats.sort(key=lambda f: f.get("height", 0), reverse=True)

    # Aynı çözünürlük/uzantıya sahip video-only formatlarını tekrarsız hale getirelim:
    unique_video_only = {}
    for f in video_only_formats:
        key = (f.get("height"), f.get("ext"))
        f_size = f.get("filesize", 0) or 0
        unique_size = unique_video_only.get(key, {}).get("filesize", 0) or 0

        if key not in unique_video_only or (f_size > unique_size):
            unique_video_only[key] = f

    video_only_formats = list(unique_video_only.values())
    video_only_formats.sort(key=lambda f: f.get("height", 0), reverse=True)

    # Hata önlemek için `.get("abr", 0)` kullandık
    audio_only_formats.sort(key=lambda f: f.get("abr") or 0, reverse=True)

    return render_template('info.html', info=info, 
                           combined_formats=combined_formats, 
                           video_only_formats=video_only_formats,
                           audio_only_formats=audio_only_formats)

# Varolan indirme fonksiyonları (combined, video_only, audio_only, video_custom) için olan fonksiyon
def download_video(task_id, video_url, format_id, mode):
    def progress_hook(d):
        if d['status'] == 'downloading':
            total = d.get('total_bytes') or d.get('total_bytes_estimate')
            downloaded = d.get('downloaded_bytes', 0)
            if total:
                percentage = downloaded / total * 100
            else:
                percentage = 0
            download_tasks[task_id]['progress'] = percentage
            download_tasks[task_id]['status'] = 'downloading'
        elif d['status'] == 'finished':
            download_tasks[task_id]['progress'] = 100
            download_tasks[task_id]['status'] = 'finished'
            if d.get('filename'):
                download_tasks[task_id]['filepath'] = d.get('filename')

    ydl_opts = {
        'progress_hooks': [progress_hook],
        'outtmpl': os.path.join("downloads", f"{task_id}.%(ext)s"),
    }
    ydl_opts.update(get_common_ydl_opts(video_url))
    
    if mode == 'combined':
        ydl_opts['format'] = format_id
    elif mode == 'video_only':
        ydl_opts['format'] = format_id
    elif mode == 'audio_only':
        ydl_opts['format'] = format_id
        ydl_opts['postprocessors'] = [{
            'key': 'FFmpegExtractAudio',
            'preferredcodec': 'mp3',
            'preferredquality': '192',
        }]
    
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([video_url])
        if (not download_tasks[task_id].get('filepath') or 
            not os.path.exists(download_tasks[task_id]['filepath'])):
            for f in os.listdir("downloads"):
                if f.startswith(task_id):
                    full_path = os.path.join("downloads", f)
                    if os.path.isfile(full_path):
                        download_tasks[task_id]['filepath'] = full_path
                        break
    except Exception as e:
        download_tasks[task_id]['status'] = 'error'
        download_tasks[task_id]['error'] = str(e)

# Yeni: Video ve ses akışını ayrı indirip birleştiren fonksiyon
def download_video_audio_merge(task_id, video_url, video_format_id, audio_format_id):
    # Adım 1: Video dosyasını indir
    download_tasks[task_id]['progress'] = 5
    common_opts = get_common_ydl_opts(video_url)
    
    video_outtmpl = os.path.join("downloads", f"{task_id}_video.%(ext)s")
    video_opts = {
        'format': video_format_id,
        'outtmpl': video_outtmpl,
        'noplaylist': True,
    }
    video_opts.update(common_opts)
    try:
        with yt_dlp.YoutubeDL(video_opts) as ydl:
            ydl.download([video_url])
        video_path = None
        for f in os.listdir("downloads"):
            if f.startswith(f"{task_id}_video"):
                video_path = os.path.join("downloads", f)
                break
        if not video_path or not os.path.exists(video_path):
            raise Exception("Video dosyası bulunamadı.")
    except Exception as e:
        download_tasks[task_id]['status'] = 'error'
        download_tasks[task_id]['error'] = "Video indirirken hata: " + str(e)
        return
    download_tasks[task_id]['progress'] = 50

    # Adım 2: Ses dosyasını indir
    audio_outtmpl = os.path.join("downloads", f"{task_id}_audio.%(ext)s")
    audio_opts = {
        'format': audio_format_id,
        'outtmpl': audio_outtmpl,
        'noplaylist': True,
    }
    audio_opts.update(common_opts)
    try:
        with yt_dlp.YoutubeDL(audio_opts) as ydl:
            ydl.download([video_url])
        audio_path = None
        for f in os.listdir("downloads"):
            if f.startswith(f"{task_id}_audio"):
                audio_path = os.path.join("downloads", f)
                break
        if not audio_path or not os.path.exists(audio_path):
            raise Exception("Audio dosyası bulunamadı.")
    except Exception as e:
        download_tasks[task_id]['status'] = 'error'
        download_tasks[task_id]['error'] = "Audio indirirken hata: " + str(e)
        return
    download_tasks[task_id]['progress'] = 75

    # Adım 3: FFmpeg ile birleştir
    merged_file = os.path.join("downloads", f"{task_id}.mp4")
    ffmpeg_cmd = [
        "ffmpeg", "-y",
        "-i", video_path,
        "-i", audio_path,
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "192k",
        merged_file
    ]
    try:
        subprocess.run(ffmpeg_cmd, check=True)
        download_tasks[task_id]['filepath'] = merged_file
        download_tasks[task_id]['status'] = 'finished'
        download_tasks[task_id]['progress'] = 100
    except Exception as e:
        download_tasks[task_id]['status'] = 'error'
        download_tasks[task_id]['error'] = "FFmpeg birleştirme hatası: " + str(e)

@app.route('/download', methods=['POST'])
def download():
    video_url = request.form.get('video_url')
    mode = request.form.get('mode')  # combined, video_only, audio_only, video_custom, video_audio
    if not video_url or not mode:
        return "Gerekli parametreler eksik", 400
    task_id = str(uuid.uuid4())
    download_tasks[task_id] = {
        'progress': 0,
        'status': 'starting',
        'filepath': None
    }
    if mode == "video_audio":
        video_format_id = request.form.get("video_format_id")
        audio_format_id = request.form.get("audio_format_id")
        if not video_format_id or not audio_format_id:
            return "Gerekli format seçenekleri eksik", 400
        thread = threading.Thread(target=download_video_audio_merge, args=(task_id, video_url, video_format_id, audio_format_id))
    else:
        format_id = request.form.get('format_id')
        if not format_id:
            return "Gerekli format seçeneği eksik", 400
        thread = threading.Thread(target=download_video, args=(task_id, video_url, format_id, mode))
    thread.start()
    return redirect(url_for('progress_page', task_id=task_id))

@app.route('/progress/<task_id>')
def progress_page(task_id):
    return render_template('progress.html', task_id=task_id)

@app.route('/progress_status')
def progress_status():
    task_id = request.args.get('task_id')
    if not task_id or task_id not in download_tasks:
        return jsonify({'error': 'Geçersiz task id'})
    task = download_tasks[task_id]
    return jsonify(task)

@app.route('/get_file/<task_id>')
def get_file(task_id):
    if task_id not in download_tasks:
        return "Geçersiz task id", 404
    task = download_tasks[task_id]
    if task.get('status') != 'finished':
        return "Dosya henüz hazır değil", 400
    filepath = task.get('filepath')
    if not filepath or not os.path.exists(filepath):
        return "Dosya bulunamadı", 404
    return send_file(filepath, as_attachment=True)

def cleanup_old_files():
    while True:
        now = time.time()
        for filename in os.listdir("downloads"):
            filepath = os.path.join("downloads", filename)
            file_age = now - os.path.getmtime(filepath)
            if file_age > 150:  # 3 dakika (180 saniye)
                try:
                    os.remove(filepath)
                except Exception as e:
                    print(f"Dosya silinemedi: {e}")
        time.sleep(60)  # 60 saniyede bir kontrol et

if __name__ == '__main__':
    cleanup_thread = threading.Thread(target=cleanup_old_files, daemon=True)
    cleanup_thread.start()
    app.run(debug=True)
