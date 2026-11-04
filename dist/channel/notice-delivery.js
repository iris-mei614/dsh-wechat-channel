import { splitText } from '../text.js';
/** Checkpoint each text chunk and attachment independently. */
export async function deliverNotice(state, notice, chunkChars, sendText, sendFile) {
    while (notice.text.trim() !== '') {
        const parts = splitText(notice.text, chunkChars);
        await sendText(parts[0]);
        state.update(() => { notice.text = parts.slice(1).join('\n'); });
        await state.flush();
    }
    while (notice.files.length > 0) {
        const file = notice.files[0];
        while (file.description?.trim()) {
            const parts = splitText(file.description, chunkChars);
            await sendText(parts[0]);
            state.update(() => { file.description = parts.slice(1).join('\n'); });
            await state.flush();
        }
        await sendFile(file);
        state.update(() => { notice.files.shift(); });
        await state.flush();
    }
    state.removePendingNotices([notice.id]);
    await state.flush();
}
