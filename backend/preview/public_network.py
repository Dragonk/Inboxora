"""Certificate fetches use public, pinned addresses and never follow redirects."""
import asyncio
import ipaddress
import socket
import aiohttp


def public_ip(value):
    ip = ipaddress.ip_address(value)
    if not ip.is_global or ip.is_multicast or ip.is_reserved:
        return False
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped or ip.sixtofour or ip.teredo:
            return False
        if ip in ipaddress.ip_network('64:ff9b::/96') or ip in ipaddress.ip_network('64:ff9b:1::/48'):
            return False
    return True


class PublicResolver(aiohttp.abc.AbstractResolver):
    async def resolve(self, host, port=0, family=socket.AF_UNSPEC):
        answers = await asyncio.get_running_loop().getaddrinfo(host, port, family=family, type=socket.SOCK_STREAM)
        if not answers or any(not public_ip(item[4][0]) for item in answers):
            raise OSError('Certificate endpoint is not public')
        return [dict(hostname=host, host=item[4][0], port=port, family=item[0], proto=item[2], flags=socket.AI_NUMERICHOST) for item in answers]

    async def close(self):
        return None


def socket_factory(address):
    family, kind, protocol, _, remote = address
    if not public_ip(remote[0]):
        raise OSError('Certificate endpoint is not public')
    return socket.socket(family, kind, protocol)


def certificate_session(*, response_limit=16 * 1024 * 1024, total_limit=32 * 1024 * 1024, request_limit=20, timeout=5, diagnostics=None):
    budget = {'requests': 0, 'bytes': 0}
    def note(code):
        if diagnostics is not None and code not in diagnostics:
            diagnostics.append(code)

    class BoundedResponse(aiohttp.ClientResponse):
        async def read(self):
            if self._body is not None:
                return self._body
            if self.headers.get('Content-Encoding', 'identity').lower() != 'identity':
                note('NETWORK_RESPONSE_REFUSED')
                self.close()
                raise aiohttp.ClientError('Encoded certificate response refused')
            if self.content_length is not None and self.content_length > response_limit:
                note('NETWORK_LIMIT')
                self.close()
                raise aiohttp.ClientError('Certificate response limit')
            chunks, size = [], 0
            async for block in self.content.iter_chunked(65536):
                size += len(block)
                budget['bytes'] += len(block)
                if size > response_limit or budget['bytes'] > total_limit:
                    note('NETWORK_LIMIT')
                    self.close()
                    raise aiohttp.ClientError('Certificate response limit')
                chunks.append(block)
            self._body = b''.join(chunks)
            return self._body

    async def start(_session, _context, params):
        url = params.url
        budget['requests'] += 1
        if (budget['requests'] > request_limit or len(str(url)) > 2048 or url.scheme not in ('http', 'https')
                or url.port not in (80, 443) or url.user is not None or url.password is not None):
            note('NETWORK_REQUEST_REFUSED')
            raise aiohttp.ClientError('Certificate request refused')

    async def redirect(_session, _context, _params):
        note('NETWORK_REDIRECT_REFUSED')
        raise aiohttp.ClientError('Certificate redirects are not followed')

    async def failed(_session, _context, _params):
        note('NETWORK_UNAVAILABLE')

    async def ended(_session, _context, params):
        if params.response.status >= 400:
            note('NETWORK_HTTP_ERROR')

    trace = aiohttp.TraceConfig()
    trace.on_request_start.append(start)
    trace.on_request_redirect.append(redirect)
    trace.on_request_exception.append(failed)
    trace.on_request_end.append(ended)
    return aiohttp.ClientSession(connector=aiohttp.TCPConnector(resolver=PublicResolver(), socket_factory=socket_factory, limit=3),
                                 timeout=aiohttp.ClientTimeout(total=timeout), trace_configs=[trace],
                                 response_class=BoundedResponse, trust_env=False, cookie_jar=aiohttp.DummyCookieJar(),
                                 auto_decompress=False, headers={'Accept-Encoding': 'identity'}, max_line_size=4096, max_field_size=4096)
