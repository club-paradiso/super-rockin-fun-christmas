# 내 사진으로 참여하기 — 구조 (D66)

방문객이 부스 카메라 대신 **자기 휴대폰에 있는 사진 한 장**을 미디어월 검수 대기열로 보내는 기능.
결정 기록은 `docs/DECISIONS.md` D66. 상태 표기는 STATUS 규칙(구현됨/검증됨/미검증/막힘)을 따른다.

## 1. 흐름 한눈에

```
부스 첫 화면 "내 사진으로 참여하기"
  → POST /api/mobile/sessions (키오스크 쿠키)
      클라우드: 이 서버가 QR 발급          → QR = https://<클라우드>/m/<token>
      허브+클라우드: 허브가 클라우드에 요청 → QR = https://<클라우드>/m/<token>
      허브 단독: 허브가 발급 (LAN)          → QR = http://<허브>/m/<token>  + "행사장 와이파이 필요" 안내
  → 휴대폰: /m/<token> (설치·가입 없음)
      사진 고르기 → 미리보기(돌리기, 원본/정사각형/세로 자르기) → 안내 읽고 동의 체크 → 보내기
      휴대폰에서 긴 변 2048px JPEG로 다시 만든 뒤 전송 (진행 막대, 네트워크 오류는 1·3·7초 뒤 자동 재시도)
  → POST /api/mobile/upload (x-upload-token, x-wall-consent: yes)
      서버: 서명·만료 확인 → 크기·형식·시그니처 → sharp 디코딩(픽셀 상한) → 방향 바로잡기
            → 메타데이터 전부 제거(EXIF·GPS·XMP) → 새 JPEG → PhotoService.putMobile
            → photos 행 (frame_id 'phone-photo', NONE) → 감사 기록된 전이 NONE→PENDING + 동의
  → 부스 화면: 3초마다 상태 확인 → "사진이 도착했어요 · 운영팀이 확인한 뒤 걸려요"
  → 관리자 검수 대기열 (현장 촬영/휴대폰 사진 필터) → 승인/반려/숨김/삭제 (기존 규칙 그대로)
  → 승인 + 동의 → wall_eligible_photos → 미디어월 로테이션 (카드 모양으로 걸림)
```

## 2. 업로드 세션 (QR 토큰)

| 항목        | 값                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------- |
| 형식        | `u1.<sessionId>.<만료 unix초>.<kioskId 또는 ->.<HMAC-SHA256 base64url>`                     |
| 키          | `HMAC(KIOSK_SESSION_SECRET, "ftl-mobile-upload-v1")` — 키오스크 쿠키와 다른 라벨, 대체 불가 |
| 유효 기간   | 15분 (`config/mobile.ts`)                                                                   |
| 저장        | 발급 시 아무것도 저장하지 않음. 사진이 오면 그때 행 생성                                    |
| 1회성       | sessionId = 사진의 `session_id` (DB unique) → QR 하나에 사진 하나                           |
| 재시도      | 같은 QR로 다시 보내면 같은 사진(200), 두 번째 사진은 생기지 않음                            |
| 재사용 방지 | 이미 쓴 QR로 다른 사진 불가, 삭제된 사진의 QR은 "쓸 수 없는 QR" 화면                        |
| 위조·만료   | 서명 불일치·잘린 토큰·만료 모두 같은 화면/같은 410 응답                                     |
| 속도 제한   | QR당 10분 6회, IP당 10분 20회, 키오스크당 QR 발급 분당 20회 (서버 인스턴스별, D-rate-limit) |
| 로그        | 토큰은 기록하지 않음. sessionId·photoId·크기만                                              |

한계(그대로 적음): QR을 찍었다고 그 사람이 현장에 있었다는 증명은 아니다. 다만 QR은 부스 화면에만
나오고 15분 뒤 죽으며, 하나에 한 장만 받고, 모든 사진은 사람이 승인해야 벽에 나간다. 공개된 상시
업로드 창구가 아니다.

## 3. 이미지 보안

- 휴대폰: 캔버스로 다시 그려 JPEG로 만든다 → 원본 파일·EXIF·GPS가 휴대폰을 떠나지 않는다.
- 서버(신뢰 안 함): `image/jpeg`·`image/png`만, 4 MB 상한(본문을 읽으면서 셈), JPEG/PNG 시그니처,
  sharp `limitInputPixels` 5천만 픽셀, 짧은 변 240px 미만 거절, `rotate()`로 방향 적용 후
  메타데이터 없이 새 JPEG(긴 변 2048px, q85). 저장되는 것은 언제나 서버가 만든 JPEG.
- 원격 URL 가져오기 없음. 저장소는 기존 비공개 버킷/허브 파일. 방문객 링크 없음(이미 가진 사진).
- **HEIC/HEIF**: iPhone Safari는 `accept="image/*"`로 고르면 대개 JPEG로 넘겨 주고, Safari는 HEIC도
  직접 디코딩한다. 디코딩이 안 되는 브라우저(대부분의 Android Chrome)에서 HEIC를 고르면 "이 사진
  형식(HEIC)은 이 브라우저에서 열 수 없어요… 스크린샷 또는 호환성 우선" 안내. **실기기 미검증.**

## 4. 허브·클라우드와의 관계 (요구사항 5B의 7가지 질문)

1. **최종 권한**: 허브가 있으면 허브. 클라우드는 허브가 가져갈 때까지만 사진을 가진다(사진함).
   클라우드만 쓰는 배포면 클라우드(Supabase)가 최종.
2. **클라우드 → 허브 전달**: 허브의 `HubInbox`가 15초마다(그리고 부스가 "도착"을 확인하는 순간)
   `/api/hub/uploads/list` → `/image` → 허브에 저장(`putMobile`, PENDING+동의) → `/ack`.
   전부 `HUB_SYNC_SECRET` Bearer.
3. **인터넷이 끊기면**: 새 QR을 만들 수 없다 → 부스가 "인터넷이 연결되지 않았어요"라고 말하고
   QR을 띄우지 않는다. 이미 클라우드 사진함에 들어간 사진은 그대로 기다리고, 연결되면 내려온다.
   그사이 어디에도 표시되지 않는다(허브에서 승인 전이므로). 현장 촬영·검수·벽은 그대로.
4. **승인 기록**: 허브(허브 배포) 또는 Supabase(클라우드 배포)의 기존 감사 로그. 클라우드 사진함
   쪽에는 `mobile_upload_consent`와 `hub_import`(가져가며 삭제)만 남는다.
5. **승인/삭제 충돌**: 사진을 가져오는 순간 클라우드 사본이 지워지므로 두 곳에서 동시에 검수되는
   일이 없다. 허브에서 이미 지운 사진이 사진함에 남아 있으면(ack 전 장애) 다시 저장하지 않고 ack만 한다.
6. **중복 방지**: session_id unique + `putMobile`이 기존 행이면 같은 사진을 돌려줌 + 가져오기는
   한 번에 한 패스(동시 호출 공유). "저장 후 ack 전 장애"도 다음 패스에서 같은 한 장.
7. **행사 종료 후 삭제**: 허브의 "행사 종료 처리"(D64)가 휴대폰 사진도 똑같이 지운다(같은 photos 행).
   클라우드 사진함에는 가져간 뒤 남는 것이 없고, 가져가지 못한 것은 클라우드 보관 기간
   (`PHOTO_RETENTION_DAYS`, 보관 cron)으로 지워진다. 허브 보관 규칙(D47/D58)도 같다:
   벽에 안 나간 사진은 24시간, 벽 사진은 행사 종료 + 24시간.

## 5. 검수와 벽

- 같은 대기열, 같은 버튼, 같은 규칙(`lib/ops/moderation.ts`). 카드에 "휴대폰 사진" 배지, 대기열에
  전체/현장 촬영/휴대폰 사진 필터, 개요 타일에 현장·휴대폰 건수, 허브+클라우드면 "휴대폰 사진 받기"
  상태(마지막 확인 시각·오류).
- 벽은 `wall_eligible_photos`만 받는다(바뀐 것 없음). 휴대폰 사진은 1:3 스트립 칸 대신 같은 집게
  위치에 340px 카드로 걸린다(`phoneCardBox`, 이웃 칸과 겹치지 않음을 단위 테스트로 확인).

## 6. 정하지 않은 것 (교회 결정 대기)

- 보관 기간, 14세 미만 기준. 휴대폰 화면의 안내는 시스템이 실제로 지키는 사실만 적었다
  ("정해진 보관 기간이 지나면 지워져요", "어린이가 나온 사진은 보호자가 함께 확인").
- 개인정보 처리 안내 정식 문구.

## 7. 파일

`config/mobile.ts` · `lib/mobile/{token,server,image,prepare}.ts` · `lib/storage/photo-service.ts`
(`putMobile`, `mobileStatus`, `mobileInbox`, `mobileInboxImage`) · `lib/cloud/{client,inbox,server}.ts` ·
`app/api/mobile/{sessions,sessions/status,upload}` · `app/api/hub/uploads/{session,status,list,image,ack}` ·
`app/m/[token]/{page,mobile-upload}.tsx` · 부스 `components/kiosk/kiosk-app.tsx` (`MobileScreen`)
