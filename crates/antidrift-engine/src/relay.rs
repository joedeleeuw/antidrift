use std::hash::{BuildHasher, RandomState};
use std::io::{ErrorKind, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::headless::{HeadlessRequest, Leftovers, RelayReply};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(2);
const REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(30);
const REPLY_WRITE_TIMEOUT: Duration = Duration::from_secs(30);
const ACCEPT_ERROR_BACKOFF: Duration = Duration::from_millis(50);
const MAX_HANDSHAKE_BYTES: u32 = 512;
const MAX_FRAME_BYTES: u32 = 512 << 20;
const HANDSHAKE_ACK: u8 = 0xAA;
const SERVED_KIND: u8 = 0;
const FAILURE_KIND: u8 = 1;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Handshake {
    version: String,
    token: String,
}

fn write_frame(stream: &mut TcpStream, bytes: &[u8]) -> std::io::Result<()> {
    let length = u32::try_from(bytes.len()).map_err(std::io::Error::other)?;
    if length > MAX_FRAME_BYTES {
        return Err(std::io::Error::other(format!(
            "a {length} byte frame exceeds the {MAX_FRAME_BYTES} byte relay limit"
        )));
    }
    stream.write_all(&length.to_le_bytes())?;
    stream.write_all(bytes)
}

fn read_exact_until(
    stream: &mut TcpStream,
    mut buffer: &mut [u8],
    deadline: Option<Instant>,
) -> std::io::Result<()> {
    while !buffer.is_empty() {
        if let Some(limit) = deadline {
            let remaining = limit
                .checked_duration_since(Instant::now())
                .ok_or_else(|| {
                    std::io::Error::new(ErrorKind::TimedOut, "request read deadline exceeded")
                })?;
            stream.set_read_timeout(Some(remaining.max(Duration::from_millis(1))))?;
        }
        match stream.read(buffer) {
            Ok(0) => {
                return Err(std::io::Error::new(
                    ErrorKind::UnexpectedEof,
                    "failed to fill whole buffer",
                ));
            }
            Ok(read_bytes) => buffer = &mut buffer[read_bytes..],
            Err(err) if err.kind() == ErrorKind::Interrupted => {}
            Err(err) => return Err(err),
        }
    }
    Ok(())
}

fn read_bounded_frame(
    stream: &mut TcpStream,
    max_bytes: u32,
    deadline: Option<Instant>,
) -> std::io::Result<Vec<u8>> {
    let mut length = [0_u8; 4];
    read_exact_until(stream, &mut length, deadline)?;
    let length = u32::from_le_bytes(length);
    if length > max_bytes {
        return Err(std::io::Error::other(format!(
            "a {length} byte frame exceeds the {max_bytes} byte relay limit"
        )));
    }
    let mut bytes = vec![0_u8; usize::try_from(length).map_err(std::io::Error::other)?];
    read_exact_until(stream, &mut bytes, deadline)?;
    Ok(bytes)
}

fn read_frame(stream: &mut TcpStream) -> std::io::Result<Vec<u8>> {
    read_bounded_frame(stream, MAX_FRAME_BYTES, None)
}

fn fresh_token() -> String {
    let state = RandomState::new();
    format!("{:016x}{:016x}", state.hash_one(0_u8), state.hash_one(1_u8))
}

fn read_request(stream: &mut TcpStream, token: &str) -> Result<HeadlessRequest, String> {
    let deadline = Some(Instant::now() + REQUEST_READ_TIMEOUT);
    stream
        .set_write_timeout(Some(REPLY_WRITE_TIMEOUT))
        .map_err(|err| format!("could not bound the reply write: {err}"))?;
    let handshake: Handshake = serde_json::from_slice(
        &read_bounded_frame(stream, MAX_HANDSHAKE_BYTES, deadline)
            .map_err(|err| format!("could not read the handshake: {err}"))?,
    )
    .map_err(|err| format!("could not decode the handshake: {err}"))?;
    if handshake.token != token {
        return Err("the request carried the wrong token".to_owned());
    }
    if handshake.version != VERSION {
        return Err(format!(
            "antidrift-linter {} cannot relay to the antidrift engine {VERSION}",
            handshake.version
        ));
    }
    stream
        .write_all(&[HANDSHAKE_ACK])
        .and_then(|()| stream.flush())
        .map_err(|err| format!("could not acknowledge the handshake: {err}"))?;
    serde_json::from_slice(
        &read_bounded_frame(stream, MAX_FRAME_BYTES, deadline)
            .map_err(|err| format!("could not read the request: {err}"))?,
    )
    .map_err(|err| format!("could not decode the request: {err}"))
}

fn write_reply(stream: &mut TcpStream, reply: &RelayReply) -> std::io::Result<()> {
    match reply {
        RelayReply::Served { output, leftovers } => {
            stream.write_all(&[SERVED_KIND])?;
            write_frame(stream, output)?;
            write_frame(stream, &serde_json::to_vec(leftovers)?)?;
        }
        RelayReply::Failure(message) => {
            stream.write_all(&[FAILURE_KIND])?;
            write_frame(stream, message.as_bytes())?;
        }
    }
    stream.flush()
}

fn serve_connection<H>(mut stream: TcpStream, address: SocketAddr, token: &str, handler: &H)
where
    H: Fn(HeadlessRequest) -> RelayReply,
{
    let reply = read_request(&mut stream, token).map_or_else(
        |err| {
            RelayReply::Failure(format!(
                "the antidrift engine relay refused a request: {err}"
            ))
        },
        handler,
    );
    if let Err(err) = write_reply(&mut stream, &reply)
        && !matches!(
            err.kind(),
            ErrorKind::BrokenPipe | ErrorKind::ConnectionReset
        )
    {
        eprintln!("antidrift engine relay could not answer {address}: {err}");
    }
}

pub(crate) fn listen<H>(handler: H) -> Result<String, String>
where
    H: Fn(HeadlessRequest) -> RelayReply + Send + Sync + 'static,
{
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|err| format!("failed to open the antidrift engine relay on 127.0.0.1: {err}"))?;
    let address = listener
        .local_addr()
        .map_err(|err| format!("failed to read the antidrift engine relay address: {err}"))?;
    let token: Arc<str> = Arc::from(fresh_token());
    let endpoint = format!("{address}/{token}");
    let handler = Arc::new(handler);
    std::thread::Builder::new()
        .name("antidrift-relay".to_owned())
        .spawn(move || {
            for accepted in listener.incoming() {
                let stream = match accepted {
                    Ok(stream) => stream,
                    Err(err) => {
                        eprintln!(
                            "antidrift engine relay {address} could not accept a request: {err}"
                        );
                        std::thread::sleep(ACCEPT_ERROR_BACKOFF);
                        continue;
                    }
                };
                let conn_token = Arc::clone(&token);
                let conn_handler = Arc::clone(&handler);
                if let Err(err) = std::thread::Builder::new()
                    .name("antidrift-relay-conn".to_owned())
                    .spawn(move || {
                        serve_connection(stream, address, &conn_token, conn_handler.as_ref());
                    })
                {
                    eprintln!("antidrift engine relay {address} could not spawn worker: {err}");
                }
            }
        })
        .map_err(|err| format!("failed to start the antidrift engine relay thread: {err}"))?;
    Ok(endpoint)
}

fn open_relay_stream(address: &str, token: &str) -> Result<TcpStream, String> {
    let socket_addr: SocketAddr = address
        .parse()
        .map_err(|err| format!("invalid relay address {address}: {err}"))?;
    let mut stream = TcpStream::connect_timeout(&socket_addr, HANDSHAKE_TIMEOUT)
        .map_err(|err| format!("could not connect: {err}"))?;
    stream
        .set_read_timeout(Some(HANDSHAKE_TIMEOUT))
        .and_then(|()| stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT)))
        .map_err(|err| format!("could not bound the handshake: {err}"))?;
    let handshake = Handshake {
        version: VERSION.to_owned(),
        token: token.to_owned(),
    };
    let encoded_handshake = serde_json::to_vec(&handshake)
        .map_err(|err| format!("could not encode the handshake: {err}"))?;
    write_frame(&mut stream, &encoded_handshake)
        .and_then(|()| stream.flush())
        .map_err(|err| format!("could not send the handshake: {err}"))?;
    let mut ack = [0_u8; 1];
    stream
        .read_exact(&mut ack)
        .map_err(|err| format!("did not receive handshake acknowledgement: {err}"))?;
    if ack != [HANDSHAKE_ACK] {
        if ack == [FAILURE_KIND]
            && let Ok(bytes) = read_frame(&mut stream)
        {
            return Err(String::from_utf8_lossy(&bytes).into_owned());
        }
        return Err(format!(
            "unexpected handshake byte 0x{:02x} before acknowledgement",
            ack[0]
        ));
    }
    stream
        .set_read_timeout(None)
        .and_then(|()| stream.set_write_timeout(None))
        .map_err(|err| format!("could not clear the handshake deadline: {err}"))?;
    Ok(stream)
}

pub(crate) fn relay(endpoint: &str, request: &HeadlessRequest) -> Result<RelayReply, String> {
    let (address, token) = endpoint
        .split_once('/')
        .ok_or_else(|| "expected ADDRESS/TOKEN".to_owned())?;
    let mut stream = open_relay_stream(address, token)?;
    let encoded_request = serde_json::to_vec(request)
        .map_err(|err| format!("could not encode the request: {err}"))?;
    write_frame(&mut stream, &encoded_request)
        .map_err(|err| format!("could not send the request: {err}"))?;
    let mut kind = [0_u8; 1];
    stream
        .read_exact(&mut kind)
        .map_err(|err| format!("could not read the reply: {err}"))?;
    let first =
        read_frame(&mut stream).map_err(|err| format!("could not read the reply: {err}"))?;
    match kind {
        [SERVED_KIND] => {
            let leftovers: Leftovers = serde_json::from_slice(
                &read_frame(&mut stream)
                    .map_err(|err| format!("could not read the leftovers: {err}"))?,
            )
            .map_err(|err| format!("could not decode the leftovers: {err}"))?;
            Ok(RelayReply::Served {
                output: first,
                leftovers,
            })
        }
        [FAILURE_KIND] => Ok(RelayReply::Failure(
            String::from_utf8_lossy(&first).into_owned(),
        )),
        [other] => Err(format!("the reply has unknown kind {other}")),
    }
}
