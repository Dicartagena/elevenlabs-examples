import 'dotenv/config';
import 'colors';
import express, { Request, Response } from 'express';
import ExpressWs from 'express-ws';
import { WebSocket } from 'ws';
import { Llm } from '~/llm';
import { Stream } from '~/stream';
import { Transcription } from '~/transcription';
import { TextToSpeech } from '~/tts';
import VoiceResponse from 'twilio/lib/twiml/VoiceResponse';

const app = ExpressWs(express()).app;
const PORT: number = parseInt(process.env.PORT || '5000');

app.post('/incoming', (req: Request, res: Response) => {
  const twiml = new VoiceResponse();

  twiml.connect().stream({
    url: `wss://${process.env.SERVER_DOMAIN}/connection`,
  });

  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml.toString());
});

app.ws('/connection', (ws: WebSocket) => {
  console.log('Twilio -> Connection opened'.underline.green);

  ws.on('error', console.error);

  const llm = new Llm();
  const stream = new Stream(ws);
  const transcription = new Transcription();
  const textToSpeech = new TextToSpeech();

  let streamSid: string;
  let callSid: string;
  let marks: string[] = [];
  let interactionCount: number = 0;

  // Incoming from MediaStream
  ws.on('message', function message(data: string) {
    const msg: {
      event: string;
      start?: { streamSid: string; callSid: string };
      media?: { payload: string };
      mark?: { name: string };
      sequenceNumber?: number;
    } = JSON.parse(data);

    if (msg.event === 'start' && msg.start) {
      streamSid = msg.start.streamSid;
      callSid = msg.start.callSid;
      stream.setStreamSid(streamSid);
      llm.setCallSid(callSid);
      console.log(
        `Twilio -> Starting Media Stream for ${streamSid}`.underline.red,
      );
      textToSpeech.generate(
        {
          partialResponseIndex: null,
          partialResponse: 'Hi, my name is Eleven. How can I help you?',
        },
        1,
      );
    } else if (msg.event === 'media' && msg.media) {
      transcription.send(msg.media.payload);
    } else if (msg.event === 'mark' && msg.mark) {
      const label: string = msg.mark.name;

      console.log(
        `Twilio -> Audio completed mark (${msg.sequenceNumber}): ${label}`.red,
      );

      marks = marks.filter((m: string) => m !== msg.mark?.name);
    } else if (msg.event === 'stop') {
      console.log(`Twilio -> Media stream ${streamSid} ended.`.underline.red);
    }
  });

  transcription.on('utterance', async (text: string) => {
    // This is a bit of a hack to filter out empty utterances
    if (marks.length > 0 && text?.length > 5) {
      console.log('Twilio -> Interruption, Clearing stream'.red);
      ws.send(
        JSON.stringify({
          streamSid,
          event: 'clear',
        }),
      );
    }
  });

  transcription.on('transcription', async (text: string) => {
    if (!text) {
      return;
    }
    console.log(`Interaction ${interactionCount} – STT -> LLM: ${text}`.yellow);
    llm.completion(text, interactionCount);
    interactionCount += 1;
  });

  llm.on(
    'llmreply',
    async (llmReply: { partialResponse: string }, icount: number) => {
      console.log(
        `Interaction ${icount}: LLM -> TTS: ${llmReply.partialResponse}`.green,
      );
      textToSpeech.generate(llmReply, icount);
    },
  );

  textToSpeech.on(
    'speech',
    (responseIndex: number, audio: string, label: string, icount: number) => {
      console.log(`Interaction ${icount}: TTS -> TWILIO: ${label}`.blue);

      stream.buffer(responseIndex, audio);
    },
  );

  stream.on('audiosent', (markLabel: string) => {
    marks.push(markLabel);
  });
});

app.listen(PORT, () => {
  console.log(`Local: http://localhost:${PORT}`);
  console.log(`Remote: https://${process.env.SERVER_DOMAIN}`);
});
