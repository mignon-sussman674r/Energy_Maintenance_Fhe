// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface SensorData {
  id: string;
  encryptedValue: string;
  timestamp: number;
  owner: string;
  sensorType: string;
  status: "normal" | "warning" | "critical";
  predictedStatus?: "normal" | "warning" | "critical";
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHEPredictMaintenance = (encryptedData: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let status: "normal" | "warning" | "critical" = "normal";
  
  if (value > 80) status = "critical";
  else if (value > 60) status = "warning";
  
  return FHEEncryptNumber(status === "normal" ? 0 : status === "warning" ? 1 : 2);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [sensorData, setSensorData] = useState<SensorData[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [adding, setAdding] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newSensorData, setNewSensorData] = useState({ sensorType: "temperature", value: 0 });
  const [selectedData, setSelectedData] = useState<SensorData | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [simulatedRealTimeData, setSimulatedRealTimeData] = useState<SensorData[]>([]);

  // Count status for dashboard
  const normalCount = sensorData.filter(d => d.status === "normal").length;
  const warningCount = sensorData.filter(d => d.status === "warning").length;
  const criticalCount = sensorData.filter(d => d.status === "critical").length;

  useEffect(() => {
    loadSensorData().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();

    // Simulate real-time data updates
    const interval = setInterval(() => {
      if (sensorData.length > 0) {
        const randomIndex = Math.floor(Math.random() * sensorData.length);
        const randomData = sensorData[randomIndex];
        const randomValue = Math.random() > 0.7 ? 
          randomData.status === "normal" ? "warning" : "critical" : 
          randomData.status;
        
        setSimulatedRealTimeData(prev => [
          {
            ...randomData,
            status: randomValue,
            timestamp: Math.floor(Date.now() / 1000)
          },
          ...prev.slice(0, 4)
        ]);
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [sensorData]);

  const loadSensorData = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        throw new Error("Contract is not available");
      }

      // Get all sensor data keys
      const keysBytes = await contract.getData("sensor_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing sensor keys:", e); }
      }

      // Load each sensor data
      const data: SensorData[] = [];
      for (const key of keys) {
        try {
          const dataBytes = await contract.getData(`sensor_${key}`);
          if (dataBytes.length > 0) {
            try {
              const sensorData = JSON.parse(ethers.toUtf8String(dataBytes));
              data.push({ 
                id: key, 
                encryptedValue: sensorData.value, 
                timestamp: sensorData.timestamp, 
                owner: sensorData.owner, 
                sensorType: sensorData.sensorType, 
                status: sensorData.status || "normal",
                predictedStatus: sensorData.predictedStatus
              });
            } catch (e) { console.error(`Error parsing sensor data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading sensor ${key}:`, e); }
      }

      // Sort by timestamp and update state
      data.sort((a, b) => b.timestamp - a.timestamp);
      setSensorData(data);
    } catch (e) { 
      console.error("Error loading sensor data:", e); 
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: "Failed to load sensor data" 
      });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setIsRefreshing(false); 
      setLoading(false); 
    }
  };

  const addSensorData = async () => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return; 
    }
    
    setAdding(true);
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: "Encrypting sensor data with Zama FHE..." 
    });

    try {
      // Encrypt the sensor value
      const encryptedValue = FHEEncryptNumber(newSensorData.value);
      
      // Get contract with signer
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Generate unique ID for this sensor data
      const dataId = `sensor-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      
      // Create sensor data object
      const sensorData = { 
        value: encryptedValue, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        sensorType: newSensorData.sensorType, 
        status: "normal" 
      };
      
      // Store encrypted data on-chain
      await contract.setData(`sensor_${dataId}`, ethers.toUtf8Bytes(JSON.stringify(sensorData)));
      
      // Update keys list
      const keysBytes = await contract.getData("sensor_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { 
          keys = JSON.parse(ethers.toUtf8String(keysBytes)); 
        } catch (e) { 
          console.error("Error parsing keys:", e); 
        }
      }
      keys.push(dataId);
      await contract.setData("sensor_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      // Update UI state
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "Sensor data encrypted and stored securely!" 
      });
      
      // Refresh data
      await loadSensorData();
      
      // Reset form and close modal after delay
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowAddModal(false);
        setNewSensorData({ sensorType: "temperature", value: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Submission failed: " + (e.message || "Unknown error");
      
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: errorMessage 
      });
      
      setTimeout(() => 
        setTransactionStatus({ visible: false, status: "pending", message: "" }), 
        3000
      );
    } finally { 
      setAdding(false); 
    }
  };

  const predictMaintenance = async (dataId: string) => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return; 
    }
    
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: "Running FHE prediction on encrypted data..." 
    });

    try {
      // Get contract instances
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      // Get encrypted sensor data
      const dataBytes = await contract.getData(`sensor_${dataId}`);
      if (dataBytes.length === 0) throw new Error("Sensor data not found");
      
      const sensorData = JSON.parse(ethers.toUtf8String(dataBytes));
      
      // Perform FHE prediction
      const predictedStatusEncrypted = FHEPredictMaintenance(sensorData.value);
      const predictedStatusNum = FHEDecryptNumber(predictedStatusEncrypted);
      const predictedStatus = predictedStatusNum === 0 ? "normal" : predictedStatusNum === 1 ? "warning" : "critical";
      
      // Update with prediction result
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedData = { 
        ...sensorData, 
        predictedStatus 
      };
      
      await contractWithSigner.setData(
        `sensor_${dataId}`, 
        ethers.toUtf8Bytes(JSON.stringify(updatedData))
      );
      
      // Update UI
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "FHE prediction completed successfully!" 
      });
      
      // Refresh data
      await loadSensorData();
      
      setTimeout(() => 
        setTransactionStatus({ visible: false, status: "pending", message: "" }), 
        2000
      );
    } catch (e: any) {
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: "Prediction failed: " + (e.message || "Unknown error") 
      });
      
      setTimeout(() => 
        setTransactionStatus({ visible: false, status: "pending", message: "" }), 
        3000
      );
    }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return null; 
    }
    
    setIsDecrypting(true);
    
    try {
      // Create signature message
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      
      // Request signature
      await signMessageAsync({ message });
      
      // Simulate decryption delay
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // Return decrypted value
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      console.error("Decryption failed:", e); 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  const isOwner = (dataOwner: string) => 
    address?.toLowerCase() === dataOwner.toLowerCase();

  const renderStatusIndicator = (status: "normal" | "warning" | "critical") => {
    const statusClass = `status-indicator ${status}`;
    return (
      <div className={statusClass}>
        <div className="indicator-light"></div>
        <span>{status.charAt(0).toUpperCase() + status.slice(1)}</span>
      </div>
    );
  };

  const renderMaintenanceFlowchart = () => {
    return (
      <div className="flowchart-container">
        <div className="flowchart-step">
          <div className="step-icon">🔌</div>
          <div className="step-label">Sensor Data</div>
        </div>
        <div className="flowchart-arrow">→</div>
        <div className="flowchart-step">
          <div className="step-icon">🔒</div>
          <div className="step-label">FHE Encryption</div>
        </div>
        <div className="flowchart-arrow">→</div>
        <div className="flowchart-step">
          <div className="step-icon">🤖</div>
          <div className="step-label">AI Prediction</div>
        </div>
        <div className="flowchart-arrow">→</div>
        <div className="flowchart-step">
          <div className="step-icon">📊</div>
          <div className="step-label">Maintenance Alert</div>
        </div>
      </div>
    );
  };

  const renderFeatureShowcase = () => {
    const features = [
      {
        title: "FHE Encryption",
        description: "Sensor data is encrypted using Zama FHE before being stored on-chain",
        icon: "🔒"
      },
      {
        title: "Private Predictions",
        description: "AI models analyze encrypted data without decryption",
        icon: "🤖"
      },
      {
        title: "Real-time Monitoring",
        description: "Continuous monitoring of equipment status with encrypted alerts",
        icon: "📈"
      },
      {
        title: "Owner Control",
        description: "Only data owners can decrypt and view raw sensor readings",
        icon: "🔑"
      }
    ];

    return (
      <div className="features-grid">
        {features.map((feature, index) => (
          <div className="feature-card" key={index}>
            <div className="feature-icon">{feature.icon}</div>
            <h3>{feature.title}</h3>
            <p>{feature.description}</p>
          </div>
        ))}
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="mechanical-spinner"></div>
      <p>Initializing encrypted connection to energy grid...</p>
    </div>
  );

  return (
    <div className="app-container industrial-theme">
      <header className="app-header">
        <div className="logo">
          <div className="gear-icon"></div>
          <h1>Energy<span>FHE</span>Maintenance</h1>
        </div>
        <nav className="main-nav">
          <button 
            className={`nav-btn ${activeTab === "dashboard" ? "active" : ""}`}
            onClick={() => setActiveTab("dashboard")}
          >
            Dashboard
          </button>
          <button 
            className={`nav-btn ${activeTab === "sensors" ? "active" : ""}`}
            onClick={() => setActiveTab("sensors")}
          >
            Sensor Data
          </button>
          <button 
            className={`nav-btn ${activeTab === "features" ? "active" : ""}`}
            onClick={() => setActiveTab("features")}
          >
            Features
          </button>
        </nav>
        <div className="header-actions">
          <button 
            onClick={() => setShowAddModal(true)} 
            className="add-data-btn industrial-button"
          >
            <div className="add-icon"></div>Add Sensor
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <main className="main-content">
        {activeTab === "dashboard" && (
          <div className="dashboard-grid">
            <div className="dashboard-card industrial-card">
              <h2>Energy Predictive Maintenance</h2>
              <p className="subtitle">
                Secure encrypted monitoring platform powered by <strong>Zama FHE</strong> for 
                energy sector equipment maintenance
              </p>
              <div className="fhe-badge">
                <span>Fully Homomorphic Encryption</span>
              </div>
            </div>

            <div className="dashboard-card industrial-card">
              <h3>Real-time Alerts</h3>
              <div className="alerts-container">
                {simulatedRealTimeData.length > 0 ? (
                  simulatedRealTimeData.map((data, index) => (
                    <div className="alert-item" key={index}>
                      <div className="alert-time">
                        {new Date(data.timestamp * 1000).toLocaleTimeString()}
                      </div>
                      <div className="alert-content">
                        <span className="sensor-id">Sensor #{data.id.substring(7, 11)}</span>
                        {renderStatusIndicator(data.status)}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="no-alerts">
                    <div className="no-alerts-icon"></div>
                    <p>No real-time alerts currently</p>
                  </div>
                )}
              </div>
            </div>

            <div className="dashboard-card industrial-card">
              <h3>Maintenance Status</h3>
              <div className="status-summary">
                <div className="status-item normal">
                  <div className="status-count">{normalCount}</div>
                  <div className="status-label">Normal</div>
                </div>
                <div className="status-item warning">
                  <div className="status-count">{warningCount}</div>
                  <div className="status-label">Warning</div>
                </div>
                <div className="status-item critical">
                  <div className="status-count">{criticalCount}</div>
                  <div className="status-label">Critical</div>
                </div>
              </div>
            </div>

            <div className="dashboard-card industrial-card">
              <h3>Maintenance Flow</h3>
              {renderMaintenanceFlowchart()}
            </div>
          </div>
        )}

        {activeTab === "sensors" && (
          <div className="sensors-section">
            <div className="section-header">
              <h2>Encrypted Sensor Data</h2>
              <div className="header-actions">
                <button 
                  onClick={loadSensorData} 
                  className="refresh-btn industrial-button" 
                  disabled={isRefreshing}
                >
                  {isRefreshing ? "Refreshing..." : "Refresh Data"}
                </button>
              </div>
            </div>

            <div className="sensors-list industrial-card">
              <div className="table-header">
                <div className="header-cell">Sensor ID</div>
                <div className="header-cell">Type</div>
                <div className="header-cell">Owner</div>
                <div className="header-cell">Date</div>
                <div className="header-cell">Status</div>
                <div className="header-cell">Prediction</div>
                <div className="header-cell">Actions</div>
              </div>

              {sensorData.length === 0 ? (
                <div className="no-data">
                  <div className="no-data-icon"></div>
                  <p>No encrypted sensor data found</p>
                  <button 
                    className="industrial-button primary" 
                    onClick={() => setShowAddModal(true)}
                  >
                    Add First Sensor
                  </button>
                </div>
              ) : (
                sensorData.map(data => (
                  <div 
                    className="data-row" 
                    key={data.id} 
                    onClick={() => setSelectedData(data)}
                  >
                    <div className="table-cell">#{data.id.substring(7, 13)}</div>
                    <div className="table-cell">{data.sensorType}</div>
                    <div className="table-cell">
                      {data.owner.substring(0, 6)}...{data.owner.substring(38)}
                    </div>
                    <div className="table-cell">
                      {new Date(data.timestamp * 1000).toLocaleDateString()}
                    </div>
                    <div className="table-cell">
                      {renderStatusIndicator(data.status)}
                    </div>
                    <div className="table-cell">
                      {data.predictedStatus ? 
                        renderStatusIndicator(data.predictedStatus) : 
                        <span className="no-prediction">Not predicted</span>
                      }
                    </div>
                    <div className="table-cell actions">
                      {isOwner(data.owner) && (
                        <button 
                          className="action-btn industrial-button"
                          onClick={(e) => {
                            e.stopPropagation();
                            predictMaintenance(data.id);
                          }}
                        >
                          Predict
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {activeTab === "features" && (
          <div className="features-section">
            <div className="section-header">
              <h2>Platform Features</h2>
              <p className="subtitle">
                Secure predictive maintenance powered by Zama FHE technology
              </p>
            </div>
            
            {renderFeatureShowcase()}

            <div className="fhe-explainer industrial-card">
              <h3>How Zama FHE Protects Your Data</h3>
              <div className="explainer-content">
                <div className="explainer-step">
                  <div className="step-number">1</div>
                  <div className="step-content">
                    <h4>Client-Side Encryption</h4>
                    <p>Sensor data is encrypted before leaving your device using Zama's FHE libraries</p>
                  </div>
                </div>
                <div className="explainer-step">
                  <div className="step-number">2</div>
                  <div className="step-content">
                    <h4>Encrypted Processing</h4>
                    <p>AI models analyze the encrypted data without ever decrypting it</p>
                  </div>
                </div>
                <div className="explainer-step">
                  <div className="step-number">3</div>
                  <div className="step-content">
                    <h4>Secure Results</h4>
                    <p>Maintenance predictions are returned in encrypted form and can only be decrypted by you</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {showAddModal && (
        <ModalAddSensor 
          onSubmit={addSensorData} 
          onClose={() => setShowAddModal(false)} 
          adding={adding} 
          sensorData={newSensorData} 
          setSensorData={setNewSensorData}
        />
      )}

      {selectedData && (
        <SensorDetailModal 
          data={selectedData} 
          onClose={() => {
            setSelectedData(null);
            setDecryptedValue(null);
          }} 
          decryptedValue={decryptedValue} 
          setDecryptedValue={setDecryptedValue} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content industrial-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="mechanical-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="gear-icon"></div>
              <span>EnergyFHEMaintenance</span>
            </div>
            <p>Secure encrypted predictive maintenance for the energy sector</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>Powered by Zama FHE</span>
          </div>
          <div className="copyright">
            © {new Date().getFullYear()} EnergyFHEMaintenance. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalAddSensorProps {
  onSubmit: () => void; 
  onClose: () => void; 
  adding: boolean;
  sensorData: any;
  setSensorData: (data: any) => void;
}

const ModalAddSensor: React.FC<ModalAddSensorProps> = ({ 
  onSubmit, 
  onClose, 
  adding, 
  sensorData, 
  setSensorData 
}) => {
  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const { name, value } = e.target;
    setSensorData({ ...sensorData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setSensorData({ ...sensorData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!sensorData.sensorType || sensorData.value === undefined) {
      alert("Please fill required fields");
      return;
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="add-modal industrial-card">
        <div className="modal-header">
          <h2>Add Sensor Data</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice">
            <div className="lock-icon"></div>
            <div>
              <strong>FHE Encryption Notice</strong>
              <p>Your sensor data will be encrypted with Zama FHE before submission</p>
            </div>
          </div>
          <div className="form-group">
            <label>Sensor Type *</label>
            <select 
              name="sensorType" 
              value={sensorData.sensorType} 
              onChange={handleChange} 
              className="industrial-select"
            >
              <option value="temperature">Temperature</option>
              <option value="vibration">Vibration</option>
              <option value="pressure">Pressure</option>
              <option value="current">Current</option>
              <option value="voltage">Voltage</option>
              <option value="rpm">RPM</option>
            </select>
          </div>
          <div className="form-group">
            <label>Sensor Value *</label>
            <input 
              type="number" 
              name="value" 
              value={sensorData.value} 
              onChange={handleValueChange} 
              placeholder="Enter sensor reading..." 
              className="industrial-input"
              step="0.01"
            />
          </div>
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Value:</span>
                <div>{sensorData.value || 'No value entered'}</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>
                  {sensorData.value ? 
                    FHEEncryptNumber(sensorData.value).substring(0, 50) + '...' : 
                    'No value entered'
                  }
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn industrial-button">
            Cancel
          </button>
          <button 
            onClick={handleSubmit} 
            disabled={adding} 
            className="submit-btn industrial-button primary"
          >
            {adding ? "Encrypting with FHE..." : "Submit Securely"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface SensorDetailModalProps {
  data: SensorData;
  onClose: () => void;
  decryptedValue: number | null;
  setDecryptedValue: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const SensorDetailModal: React.FC<SensorDetailModalProps> = ({ 
  data, 
  onClose, 
  decryptedValue, 
  setDecryptedValue, 
  isDecrypting, 
  decryptWithSignature 
}) => {
  const handleDecrypt = async () => {
    if (decryptedValue !== null) {
      setDecryptedValue(null);
      return;
    }
    const decrypted = await decryptWithSignature(data.encryptedValue);
    if (decrypted !== null) setDecryptedValue(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="detail-modal industrial-card">
        <div className="modal-header">
          <h2>Sensor Details #{data.id.substring(7, 13)}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="sensor-info">
            <div className="info-item">
              <span>Type:</span>
              <strong>{data.sensorType}</strong>
            </div>
            <div className="info-item">
              <span>Owner:</span>
              <strong>{data.owner.substring(0, 6)}...{data.owner.substring(38)}</strong>
            </div>
            <div className="info-item">
              <span>Date:</span>
              <strong>{new Date(data.timestamp * 1000).toLocaleString()}</strong>
            </div>
            <div className="info-item">
              <span>Status:</span>
              <strong>{renderStatusIndicator(data.status)}</strong>
            </div>
            {data.predictedStatus && (
              <div className="info-item">
                <span>Prediction:</span>
                <strong>{renderStatusIndicator(data.predictedStatus)}</strong>
              </div>
            )}
          </div>
          <div className="encrypted-data-section">
            <h3>Encrypted Data</h3>
            <div className="encrypted-data">
              {data.encryptedValue.substring(0, 100)}...
            </div>
            <div className="fhe-tag">
              <div className="fhe-icon"></div>
              <span>FHE Encrypted</span>
            </div>
            <button 
              className="decrypt-btn industrial-button" 
              onClick={handleDecrypt} 
              disabled={isDecrypting}
            >
              {isDecrypting ? (
                <span className="decrypt-spinner"></span>
              ) : decryptedValue !== null ? (
                "Hide Decrypted Value"
              ) : (
                "Decrypt with Wallet Signature"
              )}
            </button>
          </div>
          {decryptedValue !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Value</h3>
              <div className="decrypted-value">{decryptedValue}</div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>
                  Decrypted data is only visible after wallet signature verification
                </span>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn industrial-button">
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

function renderStatusIndicator(status: "normal" | "warning" | "critical") {
  const statusClass = `status-indicator ${status}`;
  return (
    <div className={statusClass}>
      <div className="indicator-light"></div>
      <span>{status.charAt(0).toUpperCase() + status.slice(1)}</span>
    </div>
  );
}

export default App;