// The engine's sockets are polled. Windows leaves a socket undefined after a read that timed out (SO_RCVTIMEO, it
// fails with os error 997 and the studio saw an engine error), so they are non-blocking and a loop sleeps its
// interval when nothing arrived. A send the socket cannot take at once stays queued and goes out with the next read.
use std::net::TcpStream;
use std::time::Duration;

use tungstenite::{Error, Message, WebSocket};

pub fn poll(socket: &WebSocket<TcpStream>) {
    let _ = socket.get_ref().set_nonblocking(true);
}

fn idle(error: &Error) -> bool {matches!(error, Error::Io(error) if error.kind() == std::io::ErrorKind::WouldBlock)}

// the next message, None when nothing arrived (after sleeping the interval)
pub fn read(socket: &mut WebSocket<TcpStream>, interval: Duration) -> Result<Option<Message>, Error> {
    match socket.flush() {
        Err(error) if !idle(&error) => return Err(error),
        _ => {}
    }
    match socket.read() {
        Ok(message) => Ok(Some(message)),
        Err(error) if idle(&error) => {
            std::thread::sleep(interval);
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

pub fn send(socket: &mut WebSocket<TcpStream>, message: Message) -> Result<(), Error> {
    match socket.send(message) {
        Err(error) if idle(&error) => Ok(()),
        result => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    const MESSAGES: usize = 40;
    const SIZE: usize = 1 << 20;

    fn payload(index: usize) -> Vec<u8> {(0..SIZE).map(|byte| (byte + index) as u8).collect()}

    // both directions at once with large messages and a reader that takes its time: everything arrives intact and the
    // connection stays up, however often the socket answers "would block"
    #[test]
    fn large_messages_both_ways_arrive_intact() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let client = std::thread::spawn(move || {
            let (mut socket, _) = tungstenite::client(format!("ws://{address}/"), TcpStream::connect(address).unwrap()).unwrap();
            for index in 0..MESSAGES { socket.send(Message::Binary(payload(index).into())).unwrap(); }
            let mut received = 0;
            while received < MESSAGES {
                std::thread::sleep(Duration::from_millis(5));
                match socket.read().unwrap() {
                    Message::Binary(bytes) => {
                        assert_eq!(bytes.as_ref(), payload(received + 1000).as_slice(), "message {received} back");
                        received += 1;
                    }
                    _ => {}
                }
            }
            socket.close(None).unwrap();
            while socket.read().is_ok() {}
        });
        let (stream, _) = listener.accept().unwrap();
        let mut socket = tungstenite::accept(stream).unwrap();
        poll(&socket);
        let (mut received, mut sent) = (0, 0);
        loop {
            while sent < MESSAGES {
                send(&mut socket, Message::Binary(payload(sent + 1000).into())).expect("a full socket is no broken connection");
                sent += 1;
            }
            match read(&mut socket, Duration::from_millis(1)) {
                Ok(Some(Message::Binary(bytes))) => {
                    assert_eq!(bytes.as_ref(), payload(received).as_slice(), "message {received}");
                    received += 1;
                }
                Ok(Some(Message::Close(_))) | Err(Error::ConnectionClosed) => break,
                Ok(_) => {}
                Err(error) => panic!("the connection ended: {error}"),
            }
        }
        assert_eq!(received, MESSAGES);
        drop(socket);
        client.join().unwrap();
    }
}
