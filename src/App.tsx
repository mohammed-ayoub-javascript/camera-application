import { useRef, useEffect, useState } from 'react';
import './App.css';
import * as faceapi from 'face-api.js';

interface FaceData {
  name: string;
  features: {
    eyeDistance: number;
    noseToLeftEyeDistance: number;
    noseToRightEyeDistance: number;
  };
}

function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null); 
  const [name, setName] = useState<string>('');
  const [faceData, setFaceData] = useState<FaceData[]>([]);
  const [retrievedName, setRetrievedName] = useState<string>('');
  const [port] = useState<any>(null); 

  useEffect(() => {
    startVideo();
    loadModels();
  }, []);

  useEffect(() => {
    if (retrievedName && retrievedName !== "No matching name found.") {
      sendMessageToArduino("1");
    }
  }, [retrievedName]);

  const startVideo = () => {
    navigator.mediaDevices.getUserMedia({ video: true })
      .then((currentStream) => {
        if (videoRef.current) {
          videoRef.current.srcObject = currentStream;
        }
      })
      .catch((err) => {
        console.log(err);
      });
  };

  const loadModels = () => {
    Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri('/models'),
      faceapi.nets.faceLandmark68Net.loadFromUri('/models'),
      faceapi.nets.faceRecognitionNet.loadFromUri('/models'),
      faceapi.nets.faceExpressionNet.loadFromUri('/models'),
    ]).then(() => {
      faceMyDetect();
    });
  };

  const faceMyDetect = () => {
    setInterval(async () => {
      if (videoRef.current && canvasRef.current) {
        const detections = await faceapi.detectAllFaces(videoRef.current,
          new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceExpressions();

        if (!canvasRef.current) {
          const canvas = document.createElement('canvas');
          canvas.width = videoRef.current.videoWidth;
          canvas.height = videoRef.current.videoHeight;
          canvasRef.current = canvas;
          document.body.append(canvas); 
        }

        const canvas = canvasRef.current as HTMLCanvasElement;
        faceapi.matchDimensions(canvas, {
          width: videoRef.current.videoWidth,
          height: videoRef.current.videoHeight
        });

        const resized = faceapi.resizeResults(detections, {
          width: videoRef.current.videoWidth,
          height: videoRef.current.videoHeight
        });

        faceapi.draw.drawDetections(canvas, resized);
        faceapi.draw.drawFaceLandmarks(canvas, resized);
        faceapi.draw.drawFaceExpressions(canvas, resized);
      }
    }, 1000);
  };

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setName(e.target.value);
  };

  const saveShapeWithName = async () => {
    if (videoRef.current) {
      const detections = await faceapi.detectAllFaces(videoRef.current,
        new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks();

      if (detections.length > 0) {
        const landmarks = detections[0].landmarks;
        const leftEye = landmarks.getLeftEye();
        const rightEye = landmarks.getRightEye();
        const nose = landmarks.getNose();

        const eyeDistance = Math.sqrt(
          Math.pow(rightEye[0].x - leftEye[0].x, 2) +
          Math.pow(rightEye[0].y - leftEye[0].y, 2)
        );

        const noseToLeftEyeDistance = Math.sqrt(
          Math.pow(nose[0].x - leftEye[0].x, 2) +
          Math.pow(nose[0].y - leftEye[0].y, 2)
        );

        const noseToRightEyeDistance = Math.sqrt(
          Math.pow(nose[0].x - rightEye[0].x, 2) +
          Math.pow(nose[0].y - rightEye[0].y, 2)
        );

        const currentFaceData: FaceData = {
          name: name,
          features: {
            eyeDistance,
            noseToLeftEyeDistance,
            noseToRightEyeDistance
          }
        };

        localStorage.setItem(name, JSON.stringify(currentFaceData));
        setFaceData([...faceData, currentFaceData]);
        alert(`Saved ${name}'s features successfully!`);
      } else {
        alert("No face detected. Please try again.");
      }
    }
  };

  const retrieveName = async () => {
    if (videoRef.current) {
      const detections = await faceapi.detectAllFaces(videoRef.current,
        new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks();

      if (detections.length > 0) {
        const landmarks = detections[0].landmarks;
        const leftEye = landmarks.getLeftEye();
        const rightEye = landmarks.getRightEye();
        const nose = landmarks.getNose();

        const eyeDistance = Math.sqrt(
          Math.pow(rightEye[0].x - leftEye[0].x, 2) +
          Math.pow(rightEye[0].y - leftEye[0].y, 2)
        );

        const noseToLeftEyeDistance = Math.sqrt(
          Math.pow(nose[0].x - leftEye[0].x, 2) +
          Math.pow(nose[0].y - leftEye[0].y, 2)
        );

        const noseToRightEyeDistance = Math.sqrt(
          Math.pow(nose[0].x - rightEye[0].x, 2) +
          Math.pow(nose[0].y - rightEye[0].y, 2)
        );

        const currentFeatures = {
          eyeDistance,
          noseToLeftEyeDistance,
          noseToRightEyeDistance
        };

        const storedNames = Object.keys(localStorage);
        let foundName = '';
        const threshold = 10;

        for (let name of storedNames) {
          try {
            const data = JSON.parse(localStorage.getItem(name) || '{}') as FaceData;
            const storedFeatures = data.features;

            const eyeDistanceDiff = Math.abs(storedFeatures.eyeDistance - currentFeatures.eyeDistance);
            const noseToLeftEyeDiff = Math.abs(storedFeatures.noseToLeftEyeDistance - currentFeatures.noseToLeftEyeDistance);
            const noseToRightEyeDiff = Math.abs(storedFeatures.noseToRightEyeDistance - currentFeatures.noseToRightEyeDistance);

            if (eyeDistanceDiff < threshold && noseToLeftEyeDiff < threshold && noseToRightEyeDiff < threshold) {
              foundName = data.name;
              break;
            }
          } catch (error) {
            console.error("Error parsing JSON for name:", name, error);
          }
        }

        if (foundName) {
          setRetrievedName(foundName);
        } else {
          setRetrievedName("No matching name found.");
        }
      } else {
        alert("No face detected for retrieval.");
      }
    }
  };



  const sendMessageToArduino = async (message: string) => {
    if (port && port.writable) {
      const writer = port.writable.getWriter();
      const textEncoder = new TextEncoder();
      await writer.write(textEncoder.encode(message));
      writer.releaseLock();
      console.log("Message sent to Arduino:", message);
    } else {
      console.log("Port is not open. Please connect first.");
    }
  };

  return (
    <div className="myapp">
      <div>
        <input
          type="text"
          placeholder="Enter name"
          value={name}
          onChange={handleNameChange}
        />
        <button onClick={saveShapeWithName}>Save Name and Features</button>
        <button onClick={retrieveName}>Retrieve Name</button>
      </div>
      {retrievedName && <h2>Retrieved Name: {retrievedName}</h2>}
      <video ref={videoRef} autoPlay muted width="940" height="650" />
    </div>
  );
}

export default App;
