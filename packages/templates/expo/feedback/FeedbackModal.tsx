import { useState } from 'react';
import {
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { FeedbackPayload } from './types';

interface Props {
  visible: boolean;
  context?: string;
  onDismiss: () => void;
  onSubmit: (payload: FeedbackPayload) => Promise<void>;
}

export function FeedbackModal({ visible, context, onDismiss, onSubmit }: Props) {
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    if (!message.trim()) return;
    setSending(true);
    try {
      await onSubmit({ message: message.trim(), context: context ?? 'unknown', timestamp: new Date().toISOString() });
      setMessage('');
      onDismiss();
    } catch {
      Alert.alert('Error', 'Could not send feedback. Try again later.');
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onDismiss}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.overlay}
      >
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={() => { Keyboard.dismiss(); onDismiss(); }} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={styles.title}>Share feedback</Text>
          {context ? <Text style={styles.subtitle}>About: {context}</Text> : null}
          <TextInput
            style={styles.input}
            placeholder="What could be better? What's broken? What do you love?"
            placeholderTextColor="#999"
            value={message}
            onChangeText={setMessage}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
            autoFocus
          />
          <View style={styles.actions}>
            <TouchableOpacity onPress={onDismiss} style={styles.cancelBtn}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleSend}
              disabled={!message.trim() || sending}
              style={[styles.sendBtn, (!message.trim() || sending) && styles.sendBtnDisabled]}
            >
              <Text style={[styles.sendText, (!message.trim() || sending) && styles.sendTextDisabled]}>
                {sending ? 'Sending...' : 'Send'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)' },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingBottom: Platform.OS === 'ios' ? 40 : 20,
    paddingTop: 12,
  },
  handle: { width: 36, height: 4, backgroundColor: '#ddd', borderRadius: 2, alignSelf: 'center', marginBottom: 12 },
  title: { fontSize: 20, fontWeight: '600', color: '#111', marginBottom: 4 },
  subtitle: { fontSize: 14, color: '#666', marginBottom: 12 },
  input: {
    backgroundColor: '#f5f5f5',
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    color: '#111',
    minHeight: 120,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12, marginTop: 12 },
  cancelBtn: { paddingVertical: 10, paddingHorizontal: 20 },
  cancelText: { fontSize: 16, color: '#666' },
  sendBtn: { backgroundColor: '#2d6a4f', paddingVertical: 10, paddingHorizontal: 24, borderRadius: 10 },
  sendBtnDisabled: { backgroundColor: '#ccc' },
  sendText: { fontSize: 16, fontWeight: '600', color: '#fff' },
  sendTextDisabled: { color: '#999' },
});
