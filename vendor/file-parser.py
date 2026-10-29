"""Bounded, read-only file parsing. Optional dependencies: pypdf and Pillow."""
import base64
import io
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

MAX_INPUT = 32 * 1024 * 1024
MAX_EXPANDED = 16 * 1024 * 1024
MAX_ENTRIES = 10000
EXTRA_PROTECTED_NAMES = set(json.loads(os.environ.get('WORK_CONVERSATION_PROTECTED_NAMES', '[]')))


def page(text, offset, budget):
    # Byte-budgeted UTF-8 output, with character offsets for continuation.
    if offset > len(text):
        raise ValueError('Cursor is past the end')
    chunk = text[offset:offset + budget].encode('utf-8')[:budget].decode('utf-8', errors='ignore')
    end = offset + len(chunk)
    return {'text': chunk, 'nextOffset': end if end < len(text) else None}


def xml(data):
    probe = data.replace(b'\x00', b'').upper()
    if len(data) > MAX_EXPANDED or b'<!DOCTYPE' in probe or b'<!ENTITY' in probe:
        raise ValueError('Oversized or unsafe XML')
    return ET.fromstring(data)


def tag(element):
    return element.tag.rsplit('}', 1)[-1]


def safe_member(name):
    parts = name.replace('\\', '/').split('/')
    if not name or len(name) > 1024 or name.startswith(('/', '\\')) or '..' in parts or ':' in name or '\x00' in name:
        raise ValueError('Unsafe archive member name')
    if any(p.lower() in EXTRA_PROTECTED_NAMES or re.match(r'(?i)^(\.runtime|\.ssh|\.aws|\.git|\.env(?:\..*)?|auth\.json|credentials(?:\..*)?|cookies?(?:\..*)?)$', p) or
           re.search(r'(?i)\.(dpapi|pem|key|pfx|p12)$', p) for p in parts):
        raise ValueError('Protected archive member')


def archive(path, args):
    member = args.get('member')
    offset, budget = args['offset'], args['maxBytes']
    if os.path.getsize(path) > 512 * 1024 * 1024:
        raise ValueError('Archive exceeds 512 MiB')
    is_zip = zipfile.is_zipfile(path)
    with (zipfile.ZipFile(path) if is_zip else tarfile.open(path, 'r:*')) as handle:
        entries, expanded = [], 0
        for index, entry in enumerate(handle.infolist() if is_zip else handle):
            if index >= MAX_ENTRIES:
                raise ValueError('Archive has too many entries')
            name, size = (entry.filename, entry.file_size) if is_zip else (entry.name, entry.size)
            expanded += size
            if not is_zip and expanded > 64 * 1024 * 1024:
                raise ValueError('TAR expanded listing exceeds 64 MiB')
            try:
                safe_member(name)
            except ValueError:
                continue
            regular = not entry.is_dir() and ((entry.external_attr >> 16) & 0o170000) != 0o120000 if is_zip else entry.isfile()
            entries.append({'name': name, 'size': size, 'readable': regular and size <= MAX_EXPANDED})
        if not member:
            items, used = [], 0
            for entry in entries[offset:offset + 100]:
                length = len(json.dumps(entry, ensure_ascii=False).encode('utf-8'))
                if items and used + length > budget:
                    break
                items.append(entry)
                used += length
            end = offset + len(items)
            return {'entries': items, 'totalEntries': len(entries), 'nextOffset': end if end < len(entries) else None}
        safe_member(member)
        matches = [e for e in entries if e['name'] == member]
        if len(matches) != 1 or not matches[0]['readable']:
            raise ValueError('Member missing, ambiguous, non-regular or larger than 16 MiB')
        if is_zip:
            with handle.open(member) as source:
                data = source.read(MAX_EXPANDED + 1)
        else:
            entry = handle.getmember(member)
            if not entry.isfile():
                raise ValueError('Archive links cannot be read')
            with handle.extractfile(entry) as source:
                data = source.read(MAX_EXPANDED + 1)
        if len(data) > MAX_EXPANDED:
            raise ValueError('Expanded member is too large')
        if data.startswith(b'\x89PNG\r\n\x1a\n') or data.startswith(b'\xff\xd8\xff'):
            return image_file(io.BytesIO(data))
        if b'\x00' in data[:4096] and not data.startswith((b'\xff\xfe', b'\xfe\xff')):
            return {'member': member, 'status': 'metadata_only', 'size': len(data), 'headerHex': data[:64].hex()}
        encoding = 'utf-16' if data.startswith((b'\xff\xfe', b'\xfe\xff')) else 'utf-8-sig'
        try:
            text = data.decode(encoding)
        except UnicodeError:
            try:
                text = data.decode('gb18030')
            except UnicodeError:
                return {'member': member, 'status': 'metadata_only', 'headerHex': data[:64].hex()}
        return {'member': member, **page(text, offset, budget)}


def office(path, fmt):
    with zipfile.ZipFile(path) as z:
        if len(z.infolist()) > MAX_ENTRIES:
            raise ValueError('Too many document parts')
        total = 0
        def load(name):
            nonlocal total
            total += z.getinfo(name).file_size
            if total > MAX_EXPANDED:
                raise ValueError('Expanded document exceeds 16 MiB')
            return xml(z.read(name))
        names = z.namelist()
        if fmt == 'docx':
            return '\n'.join(''.join(e.text or '' for e in p.iter() if tag(e) == 't') for p in load('word/document.xml').iter() if tag(p) == 'p')
        if fmt == 'pptx':
            slides = sorted((n for n in names if re.fullmatch(r'ppt/slides/slide\d+\.xml', n)), key=lambda n: int(re.search(r'slide(\d+)', n).group(1)))
            return '\n\n'.join(f'[Slide {i+1}]\n' + '\n'.join(e.text or '' for e in load(n).iter() if tag(e) == 't') for i, n in enumerate(slides))
        if fmt == 'xlsx':
            strings = [''.join(e.text or '' for e in s.iter() if tag(e) == 't') for s in load('xl/sharedStrings.xml')] if 'xl/sharedStrings.xml' in names else []
            sheets = sorted(n for n in names if re.fullmatch(r'xl/worksheets/sheet\d+\.xml', n))
            blocks = []
            for name in sheets:
                rows = []
                for row in load(name).iter():
                    if tag(row) != 'row':
                        continue
                    cells = []
                    for cell in row:
                        v = next((e.text or '' for e in cell if tag(e) == 'v'), '')
                        if cell.get('t') == 's':
                            v = strings[int(v)] if v else ''
                        elif cell.get('t') == 'inlineStr':
                            v = ''.join(e.text or '' for e in cell.iter() if tag(e) == 't')
                        formula = next((e.text or '' for e in cell if tag(e) == 'f'), '')
                        cells.append(f'{cell.get("r", "?")}={v}' + (f' [formula: {formula}]' if formula else ''))
                    rows.append('\t'.join(cells))
                blocks.append(f'[{name}]\n' + '\n'.join(rows))
            return '\n\n'.join(blocks)
        if fmt in ('odt', 'ods', 'odp'):
            return '\n'.join(''.join(e.itertext()) for e in load('content.xml').iter() if tag(e) in ('p', 'h'))
        if fmt == 'epub':
            parts = []
            for name in names:
                if name.endswith(('.xhtml', '.html', '.htm')):
                    parts.append(' '.join(load(name).itertext()))
            return '\n\n'.join(parts)
        raise ValueError('Document format has no parser')


def database(path, args):
    # No SQL supplied by the caller; read-only URI and fixed, quoted SELECT only.
    immutable = os.environ.get('WORK_CONVERSATION_SQLITE_IMMUTABLE') == '1'
    if immutable and any(os.path.exists(path + suffix) for suffix in ('-wal', '-journal')):
        return {'status': 'snapshot_required', 'reason': 'Database has journal/WAL sidecars. Provide a closed, checkpointed snapshot for file reads that create no sidecars.'}
    uri = Path(path).resolve().as_uri() + '?mode=ro' + ('&immutable=1' if immutable else '')
    connection = sqlite3.connect(uri, uri=True, timeout=2)
    try:
        connection.execute('PRAGMA query_only = ON')
        connection.execute('PRAGMA trusted_schema = OFF')
        connection.set_progress_handler(lambda: 1 if __import__('time').monotonic() > deadline else 0, 10000)
        deadline = __import__('time').monotonic() + 10
        tables = [r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND upper(sql) NOT LIKE '%VIRTUAL TABLE%' ORDER BY name LIMIT 1000")]
        table, offset, budget = args.get('table'), args['offset'], args['maxBytes']
        if not table:
            items, used = [], 0
            for name in tables[offset:offset+100]:
                length = len(name.encode('utf-8'))
                if items and used + length > budget:
                    break
                items.append(name)
                used += length
            end = offset + len(items)
            return {'tables': items, 'nextOffset': end if end < len(tables) else None}
        if table not in tables:
            raise ValueError('Table not found (views and arbitrary SQL are not supported)')
        quoted = '"' + table.replace('"', '""') + '"'
        # Paging follows the table scan order. A live database can change between calls.
        columns = [r[1] for r in connection.execute(f'PRAGMA table_info({quoted})')]
        if len(columns) > 128:
            raise ValueError('Table has more than 128 columns')
        projections = []
        for name in columns:
            col = '"' + name.replace('"', '""') + '"'
            projections.append(f"CASE typeof({col}) WHEN 'blob' THEN '[BLOB bytes=' || length({col}) || ', header=' || hex(substr({col},1,32)) || ']' WHEN 'text' THEN substr({col},1,2048) ELSE {col} END")
        cursor = connection.execute(f'SELECT {", ".join(projections)} FROM {quoted} LIMIT 101 OFFSET ?', (offset,))
        rows, used, more = [], 0, False
        for raw in cursor:
            row = [{'binaryBytes': len(v), 'headerHex': v[:32].hex()} if isinstance(v, bytes) else v[:2048] if isinstance(v, str) else v for v in raw]
            length = len(json.dumps(row, ensure_ascii=False).encode('utf-8'))
            if len(rows) == 100 or (rows and used + length > budget):
                more = True
                break
            if not rows and length > budget:
                return {'status': 'row_too_large', 'reason': 'Row exceeds maxBytes; increase the budget', 'columns': columns}
            rows.append(row)
            used += length
        return {'table': table, 'columns': columns, 'rows': rows, 'cellTextLimit': 2048,
                'paginationWarning': 'Rows may shift if a live database changes; no snapshot is created.', 'nextOffset': offset + len(rows) if more else None}
    finally:
        connection.close()


def image_file(path):
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = 16_000_000
    with Image.open(path) as source:
        source.seek(0)
        image = source.convert('RGBA')
        image.thumbnail((2048, 2048))
        output = io.BytesIO()
        image.save(output, format='PNG')
        data = output.getvalue()
        if len(data) > 8 * 1024 * 1024:
            raise ValueError('Converted image exceeds 8 MiB')
        return {'image': base64.b64encode(data).decode('ascii'), 'frame': 0, 'width': image.width, 'height': image.height,
                'note': 'First frame only; converted to PNG, at most 2048 pixels per side.'}


def main(path, args):
    kind, fmt = args['kind'], args.get('format')
    if kind == 'database':
        return database(path, args)
    if kind == 'media':
        program = shutil.which('ffprobe')
        if not program:
            ffmpeg = os.environ.get('WORK_CONVERSATION_FFMPEG') or shutil.which('ffmpeg')
            if not ffmpeg:
                return {'status': 'parser_unavailable', 'reason': 'Configure media.ffmpeg or install ffprobe'}
            result = subprocess.run([ffmpeg, '-hide_banner', '-protocol_whitelist', 'file,pipe', '-i', path], capture_output=True, timeout=10)
            text = result.stderr.decode('utf-8', errors='replace')
            if 'Duration:' not in text or 'Stream #' not in text:
                return {'status': 'media_error', 'reason': 'FFmpeg could not identify media streams'}
            return {'format': fmt, 'metadata_source': 'ffmpeg', **page(text, args['offset'], args['maxBytes'])}
        result = subprocess.run([program, '-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_format', '-show_streams', '-of', 'json', path], capture_output=True, timeout=10, check=True)
        return {'format': fmt, **page(result.stdout.decode('utf-8', errors='replace'), args['offset'], args['maxBytes'])}
    if kind == 'image':
        if os.path.getsize(path) > MAX_INPUT:
            raise ValueError('Image exceeds 32 MiB')
        return image_file(path)
    if kind == 'archive':
        return archive(path, args)
    if os.path.getsize(path) > MAX_INPUT:
        raise ValueError('Document exceeds 32 MiB')
    if fmt == 'pdf':
        from pypdf import PdfReader
        reader = PdfReader(path)
        if reader.is_encrypted:
            return {'status': 'encrypted', 'reason': 'Password-protected PDF is not read'}
        # Cursor addresses one page plus a character offset, so long pages are not silently discarded.
        offset = args['offset']
        page_index, character = divmod(offset, 100_000_000)
        if page_index >= len(reader.pages):
            return {'text': '', 'nextOffset': None, 'totalPages': len(reader.pages)}
        text = reader.pages[page_index].extract_text() or ''
        result = page(text, character, args['maxBytes'])
        next_character = result['nextOffset']
        result['nextOffset'] = page_index * 100_000_000 + next_character if next_character is not None else (page_index+1) * 100_000_000 if page_index+1 < len(reader.pages) else None
        return {**result, 'page': page_index+1, 'totalPages': len(reader.pages), 'note': 'Text extraction only; scanned pages need OCR.'}
    if fmt == 'rtf':
        text = Path(path).read_bytes().decode('latin-1')
        text = re.sub(r'\\u(-?\d+)\??', lambda m: chr(int(m[1]) % 65536), text)
        text = re.sub(r"\\'([0-9a-fA-F]{2})", lambda m: bytes.fromhex(m[1]).decode('cp1252', errors='replace'), text)
        text = re.sub(r'\\(?:par|line)\b\s?', '\n', text)
        text = re.sub(r'\\[a-zA-Z]+-?\d*\s?', '', text).replace('{', '').replace('}', '')
        return {'note': 'Basic RTF text extraction; layout and embedded objects are not returned.', **page(text, args['offset'], args['maxBytes'])}
    return {'format': fmt, 'note': 'Main document text only; layout, drawings and embedded objects are not returned.', **page(office(path, fmt), args['offset'], args['maxBytes'])}


if __name__ == '__main__':
    try:
        value = main(sys.argv[1], json.loads(sys.argv[2]))
    except ImportError as error:
        value = {'status': 'parser_unavailable', 'reason': f'Missing optional Python dependency: {error.name}'}
    except Exception as error:
        value = {'status': 'parse_failed', 'reason': f'{type(error).__name__}: {str(error)[:200]}'}
    print(json.dumps(value, ensure_ascii=True))
