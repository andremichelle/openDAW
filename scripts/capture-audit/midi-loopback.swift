// A virtual MIDI cable for automated tests: whatever arrives on the destination "openDAW Loop In"
// is held until its packet timestamp and then emitted on the source "openDAW Loop Out", stamped with
// the time it is emitted, like a key on a hardware keyboard. Logs every forward to stdout.
import CoreMIDI
import Foundation

var client = MIDIClientRef()
var source = MIDIEndpointRef()
var destination = MIDIEndpointRef()
var timebase = mach_timebase_info_data_t()
mach_timebase_info(&timebase)

func nanos(_ hostTime: UInt64) -> UInt64 { hostTime * UInt64(timebase.numer) / UInt64(timebase.denom) }

let queue = DispatchQueue(label: "forward", qos: .userInteractive)

func emit(_ bytes: [UInt8]) {
    var packetList = MIDIPacketList()
    let packet = MIDIPacketListInit(&packetList)
    let now = mach_absolute_time()
    _ = MIDIPacketListAdd(&packetList, MemoryLayout<MIDIPacketList>.size, packet, now, bytes.count, bytes)
    MIDIReceived(source, &packetList)
    print("forward \(bytes.map { String(format: "%02x", $0) }.joined(separator: " ")) at \(nanos(now))")
    fflush(stdout)
}

func schedule(_ bytes: [UInt8], _ timeStamp: MIDITimeStamp) {
    queue.async {
        if timeStamp > 0 {
            while true {
                let now = mach_absolute_time()
                if now >= timeStamp { break }
                let remaining = nanos(timeStamp - now)
                if remaining > 2_000_000 { usleep(useconds_t((remaining - 1_500_000) / 1000)) }
            }
        }
        emit(bytes)
    }
}

MIDIClientCreateWithBlock("openDAW Loop" as CFString, &client) { _ in }
MIDISourceCreateWithProtocol(client, "openDAW Loop Out" as CFString, ._1_0, &source)
MIDIDestinationCreateWithBlock(client, "openDAW Loop In" as CFString, &destination) { packetList, _ in
    for packet in packetList.unsafeSequence() {
        let bytes = withUnsafeBytes(of: packet.pointee.data) { Array($0.prefix(Int(packet.pointee.length))) }
        var index = 0
        while index + 2 < bytes.count {
            let status = bytes[index] & 0xF0
            if status == 0x80 || status == 0x90 {
                schedule(Array(bytes[index...index + 2]), packet.pointee.timeStamp)
                index += 3
            } else {
                index += 1
            }
        }
    }
}
print("ready")
fflush(stdout)
RunLoop.main.run()
