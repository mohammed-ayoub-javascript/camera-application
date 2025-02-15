import { useRef, useEffect, useState, useCallback } from 'react';
import './App.css';
import * as faceapi from 'face-api.js';

declare global {
  interface Navigator {
    serial?: any;
  }
}

interface FaceData {
  name: string;
  descriptor: number[];
  landmarks: faceapi.FaceLandmarks68;
  timestamp: number;
}

interface LandmarkValidation {
  isValid: boolean;
  reason?: string;
}

interface SerialPort extends EventTarget {
  readable: ReadableStream;
  writable: WritableStream;
  open(options: SerialOptions): Promise<void>;
  close(): Promise<void>;
}

const cosineSimilarity = (vecA: Float32Array, vecB: Float32Array): number => {
  const dotProduct = vecA.reduce((sum, val, i) => sum + val * vecB[i], 0);
  const normA = Math.sqrt(vecA.reduce((sum, val) => sum + val * val, 0));
  const normB = Math.sqrt(vecB.reduce((sum, val) => sum + val * val, 0));
  return dotProduct / (normA * normB);
};

const EYE_DISTANCE_THRESHOLD = 8;
const NOSE_POSITION_THRESHOLD = 10;

const compareLandmarks = (
  landmarksA: faceapi.FaceLandmarks68,
  landmarksB: faceapi.FaceLandmarks68
): boolean => {
  const leftEyeDiff = Math.abs(landmarksA.positions[36].x - landmarksB.positions[36].x);
  const rightEyeDiff = Math.abs(landmarksA.positions[45].x - landmarksB.positions[45].x);
  const noseDiff = Math.abs(landmarksA.positions[30].y - landmarksB.positions[30].y);
  
  return (
    leftEyeDiff < EYE_DISTANCE_THRESHOLD &&
    rightEyeDiff < EYE_DISTANCE_THRESHOLD &&
    noseDiff < NOSE_POSITION_THRESHOLD
  );
};

function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [name, setName] = useState<string>('');
  const SIMILARITY_WARNING_THRESHOLD = 0.7;

  const portRef = useRef<SerialPort | null>(null);
  const intervalRef = useRef<number>();
  const commandSent = useRef(false);
  const matchCounter = useRef(0);
  const MATCH_THRESHOLD_FRAMES = 3;
  const COSINE_THRESHOLD = 0.9;

  const connectToArduino = async () => {
    if (!navigator.serial) {
      alert('المتصفح لا يدعم الوصول إلى المنافذ التسلسلية');
      return;
    }
  
    let selectedPort: SerialPort;
    try {
      selectedPort = await navigator.serial.requestPort();
    } catch (error) {
      alert("تم إلغاء اختيار المنفذ: " + (error as Error).message);
      return;
    }
  
    try {
      await selectedPort.open({
        baudRate: 9600,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none'
      });
      portRef.current = selectedPort;
      alert('تم الاتصال بالاردوينو بنجاح.');
      
      const reader = selectedPort.readable.getReader();
      const readLoop = async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            console.log('Data received:', new TextDecoder().decode(value));
          }
        } catch (error) {
          console.error('Reading error:', error);
        } finally {
          reader.releaseLock();
        }
      };
      
      readLoop();
    } catch (error) {
      console.error('تفاصيل الخطأ:', error);
      alert("فشل في فتح المنفذ: " + (error as Error).message);
      if (selectedPort) {
        try {
          await selectedPort.close();
        } catch (closeError) {
          console.error('خطأ في إغلاق المنفذ:', closeError);
        }
      }
    }
  };

  const sendSerialCommand = async (command: string) => {
    if (!portRef.current) {
      await connectToArduino();
      if (!portRef.current) {
        console.error('لا يوجد اتصال بالاردوينو.');
        return;
      }
    }
    try {
      const writer = portRef.current.writable.getWriter();
      await writer.write(new TextEncoder().encode(command));
      writer.releaseLock();
      console.log(`تم إرسال الأمر: ${command}`);
    } catch (err) {
      console.error('خطأ في الإرسال:', err);
      alert('فشل الإرسال! تأكد من اتصال الآردوينو');
    }
  };

  useEffect(() => {
    startVideo();
    loadModels();
    return () => {
      if (intervalRef.current) window.clearInterval(intervalRef.current);
      if (videoRef.current?.srcObject) {
        (videoRef.current.srcObject as MediaStream).getTracks().forEach((track) => track.stop());
      }
      if (portRef.current) {
        portRef.current.close().catch((err: unknown) => console.error('خطأ أثناء إغلاق المنفذ:', err));
      }
    };
  }, []);

  const startVideo = () => {
    navigator.mediaDevices
      .getUserMedia({ video: { width: 940, height: 650 } })
      .then((stream) => {
        if (videoRef.current) videoRef.current.srcObject = stream;
      })
      .catch(console.error);
  };

  const loadModels = async () => {
    try {
      faceapi.env.monkeyPatch({
        createCanvasElement: () => document.createElement('canvas'),
        createImageElement: () => document.createElement('img'),
      });
      
      await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri('/models'),
        faceapi.nets.faceLandmark68Net.loadFromUri('/models'),
        faceapi.nets.faceRecognitionNet.loadFromUri('/models'),
      ]);
      
      faceMyDetect();
    } catch (error) {
      console.error('فشل تحميل النماذج:', error);
    }
  };

  const getMatchingName = useCallback((
    descriptor: Float32Array,
    landmarks: faceapi.FaceLandmarks68
  ): string | null => {
    let bestMatchName: string | null = null;
    let bestSimilarity = 0;
    
    const storedNames = Object.keys(localStorage).filter(key => !key.startsWith('face-api.js'));
    
    storedNames.forEach((storedName) => {
      try {
        const item = localStorage.getItem(storedName);
        if (!item) return;
        
        const data = JSON.parse(item) as FaceData;
        if (!data.descriptor || !data.landmarks || !data.timestamp) {
          console.warn('بيانات غير صالحة ل:', storedName);
          return;
        }
        
        const storedDescriptor = new Float32Array(data.descriptor);
        const storedLandmarks = faceapi.FaceLandmarks68.fromJSON(data.landmarks);
        
        const similarity = cosineSimilarity(descriptor, storedDescriptor);
        const landmarksValid = compareLandmarks(landmarks, storedLandmarks);
        
        if (similarity > bestSimilarity && landmarksValid) {
          bestSimilarity = similarity;
          bestMatchName = storedName;
        }
      } catch (error) {
        console.error('خطأ في معالجة البيانات ل:', storedName);
      }
    });
    
    return bestSimilarity >= COSINE_THRESHOLD ? bestMatchName : null;
  }, []);

  const faceMyDetect = () => {
    intervalRef.current = window.setInterval(async () => {
      if (!videoRef.current || !canvasRef.current) return;
      
      try {
        const detections = await faceapi
          .detectAllFaces(videoRef.current, new faceapi.SsdMobilenetv1Options())
          .withFaceLandmarks()
          .withFaceDescriptors();
          
        const context = canvasRef.current.getContext('2d');
        if (!context) return;
        
        context.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
        faceapi.matchDimensions(canvasRef.current, {
          width: videoRef.current.videoWidth,
          height: videoRef.current.videoHeight,
        });
        
        const resized = faceapi.resizeResults(detections, {
          width: videoRef.current.videoWidth,
          height: videoRef.current.videoHeight,
        });
        
        let faceFound = false;
        
        resized.forEach((detection) => {
          const box = detection.detection.box;
          const descriptor = detection.descriptor;
          const landmarks = detection.landmarks;
          const foundName = getMatchingName(descriptor, landmarks);
          
          if (foundName) {
            faceFound = true;
            context.strokeStyle = '#00FF00';
            context.fillStyle = '#00FF00';
            context.fillText(foundName, box.x + 5, box.y - 10);
          } else {
            const similarity = Object.keys(localStorage).reduce((max, key) => {
              try {
                const item = localStorage.getItem(key);
                if (!item) return max;
                
                const data = JSON.parse(item) as FaceData;
                if (!data.descriptor) return max;
                
                return Math.max(
                  max, 
                  cosineSimilarity(descriptor, new Float32Array(data.descriptor))
                );
              } catch (error) {
                return max;
              }
            }, 0);
            
            if (similarity > SIMILARITY_WARNING_THRESHOLD) {
              context.strokeStyle = '#FF0000';
              context.fillStyle = '#FF0000';
              context.fillText('Unknown Similar Face!', box.x + 5, box.y - 10);
            } else {
              context.strokeStyle = '#0000FF';
              context.fillStyle = '#0000FF';
              context.fillText('Unknown', box.x + 5, box.y - 10);
            }
          }
          
          context.lineWidth = 2;
          context.strokeRect(box.x, box.y, box.width, box.height);
        });
        
        if (faceFound) matchCounter.current += 1;
        else matchCounter.current = 0;
        
        if (matchCounter.current >= MATCH_THRESHOLD_FRAMES && !commandSent.current) {
          sendSerialCommand('O');
          commandSent.current = true;
        }
        
        if (!faceFound) {
          commandSent.current = false;
          matchCounter.current = 0;
        }
      } catch (error) {
        console.error('Face detection error:', error);
      }
    }, 500);
  };

  const saveFaceData = async () => {
    if (!videoRef.current || !name) {
      alert('الرجاء إدخال اسم وتشغيل الكاميرا');
      return;
    }
  
    try {
      if (videoRef.current.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA) {
        throw new Error('الكاميرا غير جاهزة بعد');
      }
  
      const detection = await faceapi
        .detectSingleFace(videoRef.current, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.8 }))
        .withFaceLandmarks()
        .withFaceDescriptor();
  
      if (!detection?.descriptor || !detection.landmarks) {
        throw new Error('لم يتم الكشف عن وجه واضح');
      }
  
      const landmarksValidation = validateLandmarks(detection.landmarks);
      if (!landmarksValidation.isValid) {
        throw new Error(`وجه غير واضح: ${landmarksValidation.reason}`);
      }
  
      const newFaceData: FaceData = {
        name,
        descriptor: Array.from(detection.descriptor),
        landmarks: detection.landmarks.toJSON(),
        timestamp: Date.now(),
      };
  
      if (localStorage.getItem(name)) {
        const overwrite = confirm('الاسم موجود مسبقاً، هل تريد استبداله؟');
        if (!overwrite) return;
      }
  
      localStorage.setItem(name, JSON.stringify(newFaceData));
      alert('تم الحفظ بنجاح!');
      setName('');
    } catch (error) {
      console.error('تفاصيل الخطأ:', error);
      alert(`فشل الحفظ: ${error instanceof Error ? error.message : 'حدث خطأ غير متوقع'}`);
    }
  };
  
  const validateLandmarks = (landmarks: faceapi.FaceLandmarks68): LandmarkValidation => {
    const EYE_ASPECT_RATIO_THRESHOLD = 0.25;
    const MOUTH_OPEN_THRESHOLD = 0.3;
  
    const leftEye = landmarks.getLeftEye();
    const rightEye = landmarks.getRightEye();
    const mouth = landmarks.getMouth();
  
    const eyeAspectRatio = (faceapi.euclideanDistance(leftEye[1], leftEye[5]) + 
                          faceapi.euclideanDistance(leftEye[2], leftEye[4])) / 
                          (2 * faceapi.euclideanDistance(leftEye[0], leftEye[3]));
  
    const mouthOpen = faceapi.euclideanDistance(mouth[3], mouth[9]) / 
                    faceapi.euclideanDistance(mouth[0], mouth[6]);
  
    if (eyeAspectRatio > EYE_ASPECT_RATIO_THRESHOLD) {
      return { isValid: false, reason: 'العينان غير مفتوحتين بالكامل' };
    }
    if (mouthOpen > MOUTH_OPEN_THRESHOLD) {
      return { isValid: false, reason: 'الفم مفتوح' };
    }
  
    return { isValid: true };
  };

  return (
    <div className="app-container">
      <div className="controls">
        <button onClick={connectToArduino} className={`connect-btn ${portRef.current ? 'connected' : ''}`}>
          {portRef.current ? 'Arduino Connected' : 'Connect Arduino'}
        </button>
        <input
          type="text"
          placeholder="Enter name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="name-input"
        />
        <button onClick={saveFaceData} className="save-btn" disabled={!name}>
          Save Face
        </button>
      </div>
      <div className="video-wrapper">
        <video ref={videoRef} autoPlay muted className="video-feed" />
        <canvas ref={canvasRef} className="overlay-canvas" />
      </div>
    </div>
  );
}

export default App;