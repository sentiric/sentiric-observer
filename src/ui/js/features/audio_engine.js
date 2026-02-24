// src/ui/js/features/audio_engine.js

class AudioEngine {
    constructor() {
        this.audioCtx = null;
        this.isPlaying = false;
        
        this.alawTable = new Float32Array(256);
        this.ulawTable = new Float32Array(256);
        this.initTables();
    }

    initTables() {
        for (let i = 0; i < 256; i++) {
            let alaw = i ^ 0x55;
            let sign = alaw & 0x80;
            let exponent = (alaw & 0x70) >> 4;
            let mantissa = alaw & 0x0f;
            let sample = (exponent === 0) ? (mantissa << 4) + 8 : ((mantissa << 4) + 0x108) << (exponent - 1);
            this.alawTable[i] = (sign === 0 ? sample : -sample) / 32768.0;

            let ulaw = ~i & 0xFF;
            sign = ulaw & 0x80;
            exponent = (ulaw & 0x70) >> 4;
            mantissa = ulaw & 0x0f;
            sample = ((mantissa << 3) + 132) << exponent;
            this.ulawTable[i] = (sign === 0 ? (sample - 132) : -(sample - 132)) / 32768.0;
        }
    }

    playTrace(traceId, storeLogs) {
        return new Promise((resolve, reject) => {
            if (this.isPlaying) {
                console.warn("Audio is already playing");
                return reject("Already playing");
            }

            const rtpLogs = storeLogs.filter(l => 
                (l.trace_id === traceId || l.attributes?.['sip.call_id'] === traceId) &&
                l.event === "RTP_PACKET" &&
                l.attributes?.['rtp.audio_b64']
            );

            if (rtpLogs.length === 0) return reject("No audio data");

            rtpLogs.sort((a, b) => (a.attributes['rtp.sequence'] || 0) - (b.attributes['rtp.sequence'] || 0));

            let totalSamples = 0;
            const decodedChunks = [];

            for (const log of rtpLogs) {
                const b64 = log.attributes['rtp.audio_b64'];
                const pt = log.attributes['rtp.payload_type'];
                
                const binaryString = atob(b64);
                const len = binaryString.length;
                const floatArray = new Float32Array(len);

                for (let i = 0; i < len; i++) {
                    const byte = binaryString.charCodeAt(i);
                    floatArray[i] = (pt === 8) ? this.alawTable[byte] : this.ulawTable[byte];
                }
                
                decodedChunks.push(floatArray);
                totalSamples += len;
            }

            if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 8000 });
            
            const audioBuffer = this.audioCtx.createBuffer(1, totalSamples, 8000);
            const channelData = audioBuffer.getChannelData(0);
            
            let offset = 0;
            for (const chunk of decodedChunks) {
                channelData.set(chunk, offset);
                offset += chunk.length;
            }

            const source = this.audioCtx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(this.audioCtx.destination);
            
            this.isPlaying = true;
            
            // UI'ın haberi olması için ses bitince resolve et
            source.onended = () => { 
                this.isPlaying = false; 
                resolve(); 
            };
            
            source.start();
        });
    }
}

// YENİ: Tekil bir örnek (Singleton) dışarı aktarıyoruz. 
// Tüm bileşenler aynı motoru kullanacak.
export const audioEngine = new AudioEngine();