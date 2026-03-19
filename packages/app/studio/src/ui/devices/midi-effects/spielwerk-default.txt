class Processor {
    * process(block, events) {
        for (const event of events) {
            if (event.gate) {
                yield event
            }
        }
    }
}
