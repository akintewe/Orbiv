// FocusBubble STT Helper — Apple SFSpeechRecognizer (on-device, Siri engine)
// Usage: stt-helper <audio-file-path>
// Prints transcript to stdout, exits 0 on success.

import Foundation
import Speech
import AVFoundation

guard CommandLine.arguments.count > 1 else {
    fputs("Usage: stt-helper <audio-file-path>\n", stderr)
    exit(1)
}

let audioURL = URL(fileURLWithPath: CommandLine.arguments[1])

// Run everything on main thread so RunLoop.main.run() keeps the process alive
DispatchQueue.main.async {
    SFSpeechRecognizer.requestAuthorization { status in
        guard status == .authorized else {
            fputs("Not authorized: \(status.rawValue)\n", stderr)
            exit(2)
        }

        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
              recognizer.isAvailable else {
            fputs("SFSpeechRecognizer unavailable\n", stderr)
            exit(3)
        }

        let request = SFSpeechURLRecognitionRequest(url: audioURL)
        request.shouldReportPartialResults = false
        request.requiresOnDeviceRecognition = false // allow server if needed

        recognizer.recognitionTask(with: request) { result, error in
            if let error = error {
                fputs("Error: \(error.localizedDescription)\n", stderr)
                exit(4)
            }
            guard let result = result, result.isFinal else { return }
            let text = result.bestTranscription.formattedString
            print(text)
            exit(0)
        }
    }
}

RunLoop.main.run()
