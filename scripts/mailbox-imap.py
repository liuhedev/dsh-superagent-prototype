#!/usr/bin/env python3
"""Bounded, read-only IMAP-over-TLS polling. JSON stdout; secrets never leave this process."""
import argparse
import email
from email import policy
from email.utils import parseaddr, parsedate_to_datetime
from datetime import datetime, timezone
import imaplib
import json
from pathlib import Path
import re
import socket
import ssl
import sys


def credentials(path, host, port):
    config = json.loads(Path(path).expanduser().read_text()).get('imap', {})
    # Bind the credential file to its server; a panel edit must not redirect existing credentials.
    if str(config.get('host', '')).casefold() != host.casefold() or config.get('port', 993) != port:
        raise ValueError('credential_server_mismatch')
    user, password = config.get('user'), config.get('password')
    if not isinstance(user, str) or not isinstance(password, str) or not user or not password:
        raise ValueError('credentials_missing')
    return user, password


def response_number(client, name):
    values = client.response(name)[1]
    if not values or not values[0]:
        raise ValueError('missing_uid_metadata')
    return int(values[0])


def literal(data):
    chunks = [part[1] for part in data if isinstance(part, tuple) and isinstance(part[1], bytes)]
    if not chunks:
        raise ValueError('missing_imap_literal')
    return b''.join(chunks)


def poll(args):
    user, password = credentials(args.config, args.host, args.port)
    if user.casefold() != args.account.casefold():
        raise ValueError('mailbox_identity_mismatch')
    socket.setdefaulttimeout(20)
    client = imaplib.IMAP4_SSL(args.host, args.port, ssl_context=ssl.create_default_context(), timeout=20)
    try:
        client.login(user, password)
        folder = '"' + args.folder.replace('\\', '\\\\').replace('"', '\\"') + '"'
        if client.select(folder, readonly=True)[0] != 'OK':
            raise ValueError('mailbox_select_failed')
        validity, next_uid = response_number(client, 'UIDVALIDITY'), response_number(client, 'UIDNEXT')
        result = dict(account=user, folder=args.folder, uidvalidity=validity, next=next_uid-1, items=[], complete=True)
        if args.after is None:
            return result
        if args.uidvalidity != validity:
            raise ValueError('uidvalidity_changed')
        if args.after >= next_uid-1:
            result['next'] = args.after
            return result
        status, values = client.uid('search', None, f'UID {args.after+1}:*')
        if status != 'OK':
            raise ValueError('mailbox_search_failed')
        ids = sorted(int(uid) for uid in values[0].split() if int(uid) > args.after)
        selected = ids[:args.limit]
        result['complete'] = len(ids) <= args.limit
        result['next'] = selected[-1] if selected else args.after
        for uid in selected:
            status, header_data = client.uid('fetch', str(uid), '(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT MESSAGE-ID REFERENCES IN-REPLY-TO DATE AUTO-SUBMITTED)] RFC822.SIZE INTERNALDATE)')
            if status != 'OK':
                raise ValueError('mailbox_header_failed')
            header = email.message_from_bytes(literal(header_data), policy=policy.default)
            subject = str(header.get('Subject', ''))
            if not subject.startswith(args.prefix):
                continue
            sender = parseaddr(str(header.get('From', '')))[1].lower()
            if args.sender and sender not in args.sender:
                continue
            metadata = b' '.join(part[0] if isinstance(part, tuple) else part for part in header_data if isinstance(part, (tuple, bytes)))
            size_match = re.search(rb'RFC822.SIZE (\d+)', metadata)
            if not size_match:
                raise ValueError('missing_message_size')
            truncated = int(size_match[1]) > 2 * 1024 * 1024
            if truncated:
                # Do not let an oversized attachment block newer alerts; keep header-only evidence.
                msg, body = header, '[Body exceeds 2 MiB; header-only evidence retained for on-demand reading.]'
            else:
                status, raw = client.uid('fetch', str(uid), '(BODY.PEEK[])')
                if status != 'OK':
                    raise ValueError('mailbox_body_failed')
                msg = email.message_from_bytes(literal(raw), policy=policy.default)
                body_part = msg.get_body(preferencelist=('plain', 'html'))
                body = body_part.get_content() if body_part else ''
                if not isinstance(body, str):
                    body = ''
                if body_part and body_part.get_content_type() == 'text/html':
                    body = re.sub(r'<[^>]+>', ' ', body)
                truncated = len(body) > 100000
                body = body[:100000]
            message_id = str(msg.get('Message-ID', '')).strip()
            references = re.findall(r'<[^<>\r\n]+>', str(msg.get('References', '')))
            parent = str(msg.get('In-Reply-To', '')).strip()
            try:
                date = parsedate_to_datetime(str(msg.get('Date', '')))
                if date.tzinfo is None:
                    date = date.replace(tzinfo=timezone.utc)
                at = date.astimezone(timezone.utc).isoformat()
            except (ValueError, TypeError, OverflowError):
                at = datetime.now(timezone.utc).isoformat()
            result['items'].append(dict(uid=uid, messageId=message_id, root=(references[0] if references else parent or message_id),
                sender=sender, subject=subject, text=body, at=at, parent=parent,
                bodyTruncated=truncated, attachments=[str(part.get_filename() or '') for part in msg.iter_attachments()]))
        return result
    finally:
        try:
            client.logout()
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--account', required=True)
    parser.add_argument('--host', required=True)
    parser.add_argument('--port', type=int, default=993)
    parser.add_argument('--folder', default='INBOX')
    parser.add_argument('--prefix', default='')
    parser.add_argument('--sender', action='append', default=[])
    parser.add_argument('--after', type=int)
    parser.add_argument('--uidvalidity', type=int)
    parser.add_argument('--limit', type=int, default=50)
    args = parser.parse_args()
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9.-]*', args.host) or not 1 <= args.port <= 65535:
        parser.error('Invalid IMAP server')
    if args.limit < 1 or args.limit > 100 or args.after is not None and (args.after < 0 or args.uidvalidity is None):
        parser.error('Invalid receiving scope or UID cursor')
    try:
        print(json.dumps(poll(args), ensure_ascii=False))
    except Exception as error:
        # Do not echo server exceptions, message content, configuration or credentials into logs.
        code = str(error) if isinstance(error, ValueError) and re.fullmatch(r'[a-z_]+', str(error)) else type(error).__name__
        print(json.dumps({'error': code}), file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
