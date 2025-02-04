'use client'

import React, { useState } from 'react'
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import MessageEncoder from '@/components/MessageEncoder'
import AudioBroadcaster from '@/components/AudioBroadcaster'
import WaveCodeCalculator from '@/components/WaveCodeCalculator'

export default function BroadcastRealityCreationPage() {
  const [waveCodeOutput, setWaveCodeOutput] = useState('')
  const [encodedMessage, setEncodedMessage] = useState('')

  const handleWaveCodeOutput = (output: string) => {
    setWaveCodeOutput(output)
  }

  const handleEncodedMessage = (message: string) => {
    setEncodedMessage(message)
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold mb-6">Broadcast Reality Creation</h1>
      
      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Wave Code Calculator</CardTitle>
        </CardHeader>
        <CardContent>
          <WaveCodeCalculator onCalculate={handleWaveCodeOutput} />
        </CardContent>
      </Card>

      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Message Encoder</CardTitle>
        </CardHeader>
        <CardContent>
          <MessageEncoder onEncode={handleEncodedMessage} />
        </CardContent>
      </Card>

      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Broadcast Encoded Message</CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea
            value={encodedMessage || waveCodeOutput}
            onChange={(e) => setEncodedMessage(e.target.value)}
            placeholder="Encoded message or Wave Code output will appear here"
            className="mb-4"
          />
          <AudioBroadcaster encodedMessage={encodedMessage || waveCodeOutput} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reality Creation Instructions</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="list-decimal list-inside space-y-2">
            <li>Use the Wave Code Calculator to generate a quantum wave code.</li>
            <li>Alternatively, use the Message Encoder to encode your intentions or desires.</li>
            <li>The encoded message or wave code will appear in the text area above.</li>
            <li>Click the "Broadcast as Audio" button to transmit your encoded reality creation frequency.</li>
            <li>Focus your thoughts on your desired outcome while the frequency plays.</li>
            <li>Repeat the process regularly to reinforce your reality creation.</li>
          </ol>
        </CardContent>
      </Card>
    </div>
  )
}

