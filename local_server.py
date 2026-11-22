from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import urlopen
import subprocess
import sys


ROOT = Path(__file__).resolve().parent / 'dist'
HOST = '127.0.0.1'
PORT = 4178
APP_URL = f'http://{HOST}:{PORT}/'
PAGES = {f'/{file.stem}': file.name for file in ROOT.glob('*.html')}
SERVER_HEADER = 'X-LTD-Local-Editor'


class EditorHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header(SERVER_HEADER, '1')
        super().end_headers()

    def translate_path(self, path):
        route = urlsplit(path).path.rstrip('/')
        if route in PAGES:
            return str(ROOT / PAGES[route])
        return super().translate_path(path)

    def list_directory(self, path):
        self.send_error(404)
        return None


def open_browser():
    if '--no-open' not in sys.argv:
        subprocess.run(['/usr/bin/open', APP_URL], check=False)


def main():
    if not (ROOT / 'index.html').is_file():
        sys.exit('找不到本地构建，请先在项目目录运行 npm run build。')

    handler = partial(EditorHandler, directory=str(ROOT))
    try:
        server = ThreadingHTTPServer((HOST, PORT), handler)
    except OSError as error:
        try:
            with urlopen(APP_URL, timeout=1) as existing:
                if existing.headers.get(SERVER_HEADER) == '1':
                    print(f'人森存档修改器正在运行\n{APP_URL}')
                    open_browser()
                    return
        except (URLError, TimeoutError):
            pass
        sys.exit(f'启动失败，端口 {PORT} 可能已被占用。{error}')

    with server:
        print(f'人森存档修改器已启动\n{APP_URL}\n按 Ctrl+C 或关闭此终端即可停止。', flush=True)
        open_browser()
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
