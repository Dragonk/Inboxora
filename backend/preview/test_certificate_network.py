"""Exercise bounded response reads without opening a public or private socket."""
import asyncio
import unittest
from unittest.mock import patch, MagicMock
import aiohttp
from public_network import certificate_session


class BoundedCertificateBody(unittest.IsolatedAsyncioTestCase):
    async def test_text_and_repeat_reads_reuse_the_bounded_body(self):
        from multidict import CIMultiDict, CIMultiDictProxy
        from yarl import URL
        async with certificate_session(response_limit=32, total_limit=40) as session:
            def response(payload):
                result = session._response_class('GET', URL('https://example.test/ca'), request_info=MagicMock(), writer=None, stream_writer=MagicMock(output_size=0),
                    continue100=None, timer=None, traces=[], loop=asyncio.get_running_loop(), session=session)
                result._headers = CIMultiDictProxy(CIMultiDict({'Content-Type': 'text/xml', 'Content-Length': str(len(payload))}))
                result.content = aiohttp.StreamReader(MagicMock(), limit=65536, loop=asyncio.get_running_loop())
                result.content.feed_data(payload); result.content.feed_eof()
                return result
            value = response(b'<issuer/>')
            self.assertEqual(await value.text(), '<issuer/>')
            self.assertEqual(await value.read(), b'<issuer/>')
            self.assertEqual(await value.text(), '<issuer/>')
            with self.assertRaises(aiohttp.ClientError): await response(b'x'*33).read()
            with self.assertRaises(aiohttp.ClientError): await response(b'x'*32).read()

    async def test_private_redirect_target_is_refused_by_the_shared_request_policy(self):
        # Literal IPs bypass DNS, so validate the socket boundary as well.
        from public_network import socket_factory
        import socket
        with self.assertRaises(OSError):
            socket_factory((socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 443)))
        with self.assertRaises(OSError):
            socket_factory((socket.AF_INET, socket.SOCK_STREAM, 6, '', ('169.254.169.254', 80)))
