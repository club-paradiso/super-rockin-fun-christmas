import type { CameraErrorKind } from "@/lib/camera/types";

/**
 * Every guest-facing booth string, in Korean, English and Chinese (D78, D89). The guest picks the
 * language on the first screen; the next guest starts in Korean again (lib/kiosk/machine.ts
 * `lang`). Chinese is Simplified (简体中文).
 *
 * The Korean strings are the user's own wording (D76): do not reword them here. Staff-only text
 * (help mode, status badges) stays Korean and is not in this file. Line breaks are "\n" and are
 * rendered by the screens.
 */
export type KioskLang = "ko" | "en" | "zh";
export const KIOSK_LANGS: readonly KioskLang[] = ["ko", "en", "zh"];

/** The value for `<html lang>`: Simplified Chinese glyphs need the script subtag. */
export const HTML_LANG: Record<KioskLang, string> = { ko: "ko", en: "en", zh: "zh-Hans" };

const ko = {
  langName: "한국어",
  langGroup: "언어 · Language",
  /** The attract screen (D80). The guest has not chosen a language yet: it shows both. */
  attract: {
    start: "화면을 눌러 시작",
    event: "Christmas Village 2026",
  },
  welcome: {
    title: "크리스마스의 추억을 함께 남겨요",
    lead: "사진을 찍어 휴대폰으로 받거나, 내 사진을 보내 큰 화면에 함께 걸어요.",
    camera: "여기서 사진 찍기",
    cameraLead: "여섯 장 찍고 골라서 휴대폰으로 받아요",
    mobile: "내 사진으로 참여하기",
    mobileLead: "휴대폰에 있는 사진을 미디어월로 보내요",
    paused: "미디어월 게시 신청을 잠시 멈췄어요. 사진 찍기는 지금도 할 수 있어요",
  },
  chrome: {
    back: "이전",
    home: "처음으로",
  },
  steps: {
    of: (step: number, total: number) => `${total}단계 중 ${step}단계`,
  },
  frame: {
    pickTitle: "마음에 드는 틀을 골라주세요",
    againTitle: "사진을 넣어 봤어요",
    againLead: "다른 틀이 더 잘 어울리면 바꿔도 돼요.",
    slots: (n: number) => `${n}컷 템플릿`,
    pickConfirm: "이 틀로 찍기",
    againConfirm: "이 틀로 할게요",
  },
  camera: {
    startingTitle: "카메라를 켜고 있어요",
    startingLead: "허용을 묻는 창이 뜨면 ‘허용’을 눌러 주세요.",
    preview: "미리보기를 준비하고 있어요…",
    retry: "다시 시도",
    home: "처음으로",
    choose: "카메라",
    defaultDevice: "기본 카메라",
    errors: {
      denied: {
        title: "카메라 사용이 허용되지 않았어요",
        lead: "도우미에게 알려 주세요. 브라우저 설정에서 카메라를 허용해야 해요.",
      },
      missing: {
        title: "카메라를 찾을 수 없어요",
        lead: "카메라 연결을 확인한 뒤 다시 시도해 주세요.",
      },
      unsupported: {
        title: "이 화면에서는 카메라를 쓸 수 없어요",
        lead: "HTTPS 주소 또는 지원되는 브라우저에서 열어야 해요. 도우미에게 알려 주세요.",
      },
      failed: { title: "카메라가 잠시 멈췄어요", lead: "다시 시도를 눌러 주세요." },
    } satisfies Record<CameraErrorKind, { title: string; lead: string }>,
  },
  shoot: {
    shot: (n: number) => `${n}번째 사진`,
    retakeShot: (n: number) => `${n}번째 사진 다시 찍기`,
    lead: "카메라를 보고 웃어주세요.\n숫자가 0이 되면 찍혀요.",
    free: "자유 포즈로 찍기",
    guide: "포즈 추천받고 찍기",
    plan: (seconds: number, total: number) => `${seconds}초마다 한 컷씩, 모두 ${total}컷을 찍어요`,
    video: "촬영하는 모습을 짧은 영상으로도 담아요. 소리는 담지 않아요.",
    pose: "추천 포즈",
    progress: (done: number, total: number) => `${total}장 중 ${done}장 촬영`,
  },
  review: {
    title: "잘 나왔나요?",
    retake: "다시 찍기",
    confirm: "이대로 좋아요",
  },
  select: {
    title: (required: number, total: number) => `${total}장 중 ${required}장을 골라주세요`,
    lead: (selected: number, required: number) =>
      `선택한 순서대로 프레임에 들어가요. ${selected} / ${required}장 선택했어요.`,
    choose: (n: number) => `${n}번째 사진 선택`,
    unchoose: (n: number) => `${n}번째 사진 선택 해제`,
    changeFrame: "프레임 바꾸기",
    confirm: "이 사진으로 완성하기",
  },
  consent: {
    title: "이 사진을 미디어월에\n띄워도 될까요?",
    lead: "미디어월에 다른 분들 사진과 함께 돌아가며 보여요.\n아니요를 눌러도 사진은 받을 수 있어요.",
    yes: "네, 띄워주세요",
    no: "아니요, 저만 볼게요",
    note: "사진은 정해진 기간이 지나면 지워져요.\n띄운 뒤에도 안내 봉사자에게 말하면 바로 내려드려요.",
    // D86, shown only while staff have the public wall on. Written by Claude (2026-11-13), not
    // yet the user's wording (D76): it has to say plainly that the wall is also on the internet.
    publicNote: "미디어월은 행사장 화면과 온라인 주소에서 함께 보여요.",
    finished: "완성된 사진",
    making: "사진을 만들고 있어요",
  },
  delivery: {
    title: "휴대폰으로 사진을 받아 가세요",
    lead: "휴대폰 카메라로 QR을 비춰 주세요.",
    onWall: "잠시 뒤 큰 화면에서 내 사진을 찾아보세요.",
    done: "다 받았어요",
    resetSoon: "잠시 뒤 처음 화면으로 돌아가요",
    qrNote: "휴대폰으로 찍으면\n사진 파일을 받을 수 있어요",
    session: (code: string) => `세션 ${code}`,
    pendingTitle: "QR을 준비하고 있어요",
    pendingLead:
      "사진은 안전하게 저장했어요. 인터넷이 조금 느려서 QR이 늦어지고 있어요.\n잠시만 기다리면 이 화면에 QR이 나와요.",
    withoutQr: "QR 없이 처음으로",
    authTitle: "도우미를 불러 주세요",
    authLead: "이 기기 등록이 필요해요. 사진은 이 기기에 안전하게 보관 중이에요.",
    queuedTitle: "사진을 보내고 있어요",
    queuedLead:
      "사진은 이 기기에 안전하게 저장했어요.\n연결되면 자동으로 보내고 QR을 보여 드릴게요.",
    retry: "다시 시도",
    failedTitle: "사진을 보내지 못했어요",
    failedLead: "도우미에게 알려 주세요.",
    home: "처음으로",
    sendingTitle: "사진을 보내고 있어요",
    sendingLead: "잠시만 기다려 주세요.",
  },
  mobile: {
    receivedTitle: "사진이 도착했어요",
    receivedLead:
      "운영팀이 확인한 뒤 미디어월에 걸어 드려요.\n확인에는 시간이 조금 걸릴 수 있어요.",
    home: "처음으로",
    retry: "다시 시도",
    failed: {
      offline: {
        title: "지금은 인터넷이 연결되지 않았어요",
        lead: "내 사진 보내기는 인터넷이 필요해요. 사진 찍기는 지금도 할 수 있어요.",
      },
      paused: {
        title: "미디어월 게시 신청을 잠시 멈췄어요",
        lead: "잠시 뒤 다시 시도해 주세요. 사진 찍기는 지금도 할 수 있어요.",
      },
      error: { title: "QR을 만들지 못했어요", lead: "다시 시도를 눌러 주세요." },
    },
    title: "휴대폰으로 QR을 찍어 주세요",
    stepsLabel: "순서",
    steps: [
      "휴대폰 카메라로 QR을 찍어요",
      "열린 화면에서 사진을 1~6장 고르고 틀을 골라요",
      "안내를 읽고 ‘미디어월로 보내기’를 눌러요",
    ],
    note: "운영팀이 확인한 사진만 미디어월에 걸려요. 회원가입이나 앱 설치는 필요 없어요.",
    lan: "휴대폰이 행사장 와이파이에 연결되어 있어야 열려요.",
    making: "QR을 만들고 있어요…",
    waiting: "사진이 도착하면\n이 화면이 바뀌어요",
  },
  idle: {
    warning: (seconds: number) =>
      `${seconds}초 뒤 처음 화면으로 돌아가요. 계속하려면 화면을 눌러 주세요.`,
    stay: "계속할게요",
  },
  home: {
    title: "처음 화면으로 갈까요?",
    lead: "지금까지 찍은 사진은 지워지고 저장되지 않아요.",
    stay: "계속 찍을게요",
    leave: "처음으로 갈게요",
  },
};

export type KioskCopy = typeof ko;

const en: KioskCopy = {
  langName: "English",
  langGroup: "언어 · Language",
  attract: {
    start: "Tap the screen to start",
    event: "Christmas Village 2026",
  },
  welcome: {
    title: "Make a Christmas memory together",
    lead: "Take photos and get them on your phone, or send your own photo to hang on the big screen.",
    camera: "Take photos here",
    cameraLead: "Take six, pick your favorites, and get them on your phone",
    mobile: "Share a photo from your phone",
    mobileLead: "Send a photo from your phone to the media wall",
    paused: "Media wall submissions are paused right now. You can still take photos here",
  },
  chrome: {
    back: "Back",
    home: "Start over",
  },
  steps: {
    of: (step, total) => `Step ${step} of ${total}`,
  },
  frame: {
    pickTitle: "Choose a frame you like",
    againTitle: "Here are your photos in each frame",
    againLead: "If another frame suits you better, go ahead and switch.",
    slots: (n) => `${n}-photo frame`,
    pickConfirm: "Use this frame",
    againConfirm: "Go with this frame",
  },
  camera: {
    startingTitle: "Turning on the camera",
    startingLead: "If a window asks for permission, tap “Allow.”",
    preview: "Getting the preview ready…",
    retry: "Try again",
    home: "Start over",
    choose: "Camera",
    defaultDevice: "Default camera",
    errors: {
      denied: {
        title: "Camera access isn’t allowed",
        lead: "Please tell a helper. The camera needs to be allowed in the browser settings.",
      },
      missing: {
        title: "We can’t find the camera",
        lead: "Check that the camera is connected, then try again.",
      },
      unsupported: {
        title: "The camera can’t be used on this screen",
        lead: "It needs an HTTPS address or a supported browser. Please tell a helper.",
      },
      failed: { title: "The camera stopped for a moment", lead: "Tap “Try again.”" },
    },
  },
  shoot: {
    shot: (n) => `Photo ${n}`,
    retakeShot: (n) => `Retaking photo ${n}`,
    lead: "Look at the camera and smile.\nThe photo is taken when the count reaches 0.",
    free: "Pose freely",
    guide: "Get pose ideas",
    plan: (seconds, total) => `One photo every ${seconds} seconds, ${total} in all`,
    video: "We also film a short clip while you pose. No sound is recorded.",
    pose: "Try this pose",
    progress: (done, total) => `${done} of ${total} photos taken`,
  },
  review: {
    title: "How did they turn out?",
    retake: "Retake",
    confirm: "Looks good",
  },
  select: {
    title: (required, total) => `Pick ${required} of your ${total} photos`,
    lead: (selected, required) =>
      `They go into the frame in the order you pick them. ${selected} of ${required} picked.`,
    choose: (n) => `Pick photo ${n}`,
    unchoose: (n) => `Unpick photo ${n}`,
    changeFrame: "Change frame",
    confirm: "Finish with these",
  },
  consent: {
    title: "Can we show this photo\non the media wall?",
    lead: "It will take turns on the wall with other guests’ photos.\nYou still get your photo if you say no.",
    yes: "Yes, show it",
    no: "No, just for me",
    note: "Photos are deleted after a set period.\nIf you change your mind later, tell a volunteer and we’ll take it down right away.",
    publicNote: "The media wall is shown on the screen here and at its web address.",
    finished: "Your finished photo",
    making: "Making your photo",
  },
  delivery: {
    title: "Get your photo on your phone",
    lead: "Point your phone’s camera at the QR code.",
    onWall: "Look for your photo on the big screen in a little while.",
    done: "All done",
    resetSoon: "This screen will reset in a moment",
    qrNote: "Scan it with your phone\nto download the photo",
    session: (code) => `Session ${code}`,
    pendingTitle: "Getting your QR code ready",
    pendingLead:
      "Your photo is saved. The internet is a little slow, so the QR code is taking longer.\nWait a moment and it will appear here.",
    withoutQr: "Start over without the QR",
    authTitle: "Please call a helper",
    authLead: "This device needs to be registered. Your photo is kept safe on it.",
    queuedTitle: "Sending your photo",
    queuedLead:
      "Your photo is saved on this device.\nOnce we’re connected, we’ll send it and show the QR code.",
    retry: "Try again",
    failedTitle: "We couldn’t send your photo",
    failedLead: "Please tell a helper.",
    home: "Start over",
    sendingTitle: "Sending your photo",
    sendingLead: "Just a moment, please.",
  },
  mobile: {
    receivedTitle: "Your photo arrived",
    receivedLead:
      "Our team will check it, then hang it on the media wall.\nThis may take a little while.",
    home: "Start over",
    retry: "Try again",
    failed: {
      offline: {
        title: "We’re not connected to the internet right now",
        lead: "Sending your own photo needs the internet. You can still take photos here.",
      },
      paused: {
        title: "Media wall submissions are paused right now",
        lead: "Please try again in a little while. You can still take photos here.",
      },
      error: { title: "We couldn’t make a QR code", lead: "Tap “Try again.”" },
    },
    title: "Scan the QR code with your phone",
    stepsLabel: "Steps",
    steps: [
      "Scan the QR code with your phone’s camera",
      "On the page that opens, choose 1 to 6 photos and a frame",
      "Read the note, then tap “미디어월로 보내기” (Send to the media wall)",
    ],
    note: "Only photos our team has checked go on the wall. No sign-up or app needed.",
    lan: "Your phone needs to be on the event Wi-Fi for this to open.",
    making: "Making the QR code…",
    waiting: "This screen changes\nwhen your photo arrives",
  },
  idle: {
    warning: (seconds) =>
      `Going back to the start in ${seconds} seconds. Tap the screen to keep going.`,
    stay: "Keep going",
  },
  home: {
    title: "Go back to the start?",
    lead: "The photos you’ve taken so far will be deleted and not saved.",
    stay: "Keep going",
    leave: "Start over",
  },
};

const zh: KioskCopy = {
  langName: "中文",
  langGroup: "언어 · Language",
  attract: {
    start: "点击屏幕开始",
    event: "Christmas Village 2026",
  },
  welcome: {
    title: "一起留下圣诞的回忆",
    lead: "拍照后用手机领取，或者把你的照片发上来，一起挂到大屏幕上。",
    camera: "在这里拍照",
    cameraLead: "拍六张，挑选后用手机领取",
    mobile: "用我的照片参与",
    mobileLead: "把手机里的照片发送到媒体墙",
    paused: "目前暂时停止接收照片",
  },
  chrome: {
    back: "上一步",
    home: "回到开头",
  },
  steps: {
    of: (step, total) => `第 ${step} 步，共 ${total} 步`,
  },
  frame: {
    pickTitle: "请选择你喜欢的相框",
    againTitle: "已放入你的照片",
    againLead: "如果其他相框更适合，也可以更换。",
    slots: (n) => `${n} 张相框`,
    pickConfirm: "用这个相框拍照",
    againConfirm: "就用这个相框",
  },
  camera: {
    startingTitle: "正在打开摄像头",
    startingLead: "如果弹出请求权限的窗口，请点“允许”。",
    preview: "正在准备预览……",
    retry: "再试一次",
    home: "回到开头",
    choose: "摄像头",
    defaultDevice: "默认摄像头",
    errors: {
      denied: {
        title: "摄像头未被允许使用",
        lead: "请告诉工作人员。需要在浏览器设置中允许使用摄像头。",
      },
      missing: {
        title: "找不到摄像头",
        lead: "请检查摄像头是否连接好，然后再试一次。",
      },
      unsupported: {
        title: "这个屏幕无法使用摄像头",
        lead: "需要用 HTTPS 地址或受支持的浏览器打开。请告诉工作人员。",
      },
      failed: { title: "摄像头暂时停住了", lead: "请点“再试一次”。" },
    },
  },
  shoot: {
    shot: (n) => `第 ${n} 张照片`,
    retakeShot: (n) => `重拍第 ${n} 张照片`,
    lead: "请看着镜头微笑。\n数字变成 0 就会拍下来。",
    free: "自由摆姿势",
    guide: "给我姿势建议",
    plan: (seconds, total) => `每隔 ${seconds} 秒拍一张，一共 ${total} 张`,
    video: "拍照的过程也会录成一段短视频，不会录声音。",
    pose: "推荐姿势",
    progress: (done, total) => `已拍 ${done} 张，共 ${total} 张`,
  },
  review: {
    title: "拍得好看吗？",
    retake: "重拍",
    confirm: "就这样吧",
  },
  select: {
    title: (required, total) => `请从 ${total} 张中选 ${required} 张`,
    lead: (selected, required) => `会按你选择的顺序放进相框。已选 ${selected} / ${required} 张。`,
    choose: (n) => `选择第 ${n} 张照片`,
    unchoose: (n) => `取消选择第 ${n} 张照片`,
    changeFrame: "更换相框",
    confirm: "用这些照片完成",
  },
  consent: {
    title: "可以把这张照片\n放到媒体墙上吗？",
    lead: "照片会和其他人的照片一起轮流显示在媒体墙上。\n选“不用”也一样可以领取照片。",
    yes: "好的，请放上去",
    no: "不用，只给我自己看",
    note: "照片会在规定期限后删除。\n放上去之后，只要告诉引导志愿者，我们会马上撤下。",
    publicNote: "媒体墙会同时显示在活动现场的屏幕和网络地址上。",
    finished: "完成的照片",
    making: "正在制作照片",
  },
  delivery: {
    title: "请用手机领取照片",
    lead: "请用手机摄像头扫描二维码。",
    onWall: "稍后请在大屏幕上找找你的照片。",
    done: "已经领取了",
    resetSoon: "稍后会回到开头画面",
    qrNote: "用手机扫描后\n就能下载照片文件",
    session: (code) => `编号 ${code}`,
    pendingTitle: "正在准备二维码",
    pendingLead:
      "照片已安全保存。网络有点慢，二维码来得比较晚。\n请稍等，二维码会出现在这个画面上。",
    withoutQr: "不要二维码，回到开头",
    authTitle: "请叫工作人员过来",
    authLead: "这台设备需要登记。照片已安全保存在这台设备上。",
    queuedTitle: "正在发送照片",
    queuedLead: "照片已保存在这台设备上。\n一连上网络，我们就会自动发送并显示二维码。",
    retry: "再试一次",
    failedTitle: "照片发送失败",
    failedLead: "请告诉工作人员。",
    home: "回到开头",
    sendingTitle: "正在发送照片",
    sendingLead: "请稍等一下。",
  },
  mobile: {
    receivedTitle: "照片已收到",
    receivedLead: "运营团队确认后，会把它挂到媒体墙上。\n确认可能需要一点时间。",
    home: "回到开头",
    retry: "再试一次",
    failed: {
      offline: {
        title: "目前没有连接到网络",
        lead: "发送自己的照片需要网络。现在仍然可以在这里拍照。",
      },
      paused: {
        title: "目前暂时停止接收照片",
        lead: "请稍后再试。现在仍然可以在这里拍照。",
      },
      error: { title: "无法生成二维码", lead: "请点“再试一次”。" },
    },
    title: "请用手机扫描二维码",
    stepsLabel: "步骤",
    steps: [
      "用手机摄像头扫描二维码",
      "在打开的页面中选 1～6 张照片，再选一个相框",
      "阅读说明后，点“미디어월로 보내기”（发送到媒体墙）",
    ],
    note: "只有运营团队确认过的照片才会挂到媒体墙上。不需要注册，也不需要安装应用。",
    lan: "手机需要连接活动现场的 Wi-Fi 才能打开。",
    making: "正在生成二维码……",
    waiting: "照片收到后\n这个画面会切换",
  },
  idle: {
    warning: (seconds) => `${seconds} 秒后会回到开头画面。要继续的话，请点一下屏幕。`,
    stay: "继续",
  },
  home: {
    title: "要回到开头画面吗？",
    lead: "目前拍的照片会被删除，不会保存。",
    stay: "继续拍",
    leave: "回到开头",
  },
};

export const KIOSK_COPY: Record<KioskLang, KioskCopy> = { ko, en, zh };

/** Text with "\n" line breaks, for the screens to render. */
export function lines(text: string): string[] {
  return text.split("\n");
}

/** A frame's or pose's name in the guest's language; Korean when a language has none. */
export function localizedLabel(
  item: { label: string; labelEn?: string; labelZh?: string },
  lang: KioskLang,
): string {
  if (lang === "en") return item.labelEn ?? item.label;
  if (lang === "zh") return item.labelZh ?? item.label;
  return item.label;
}
